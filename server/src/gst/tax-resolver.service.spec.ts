import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TaxResolverService } from './tax-resolver.service';

/**
 * This decides the rate printed on a statutory invoice.
 *
 * Two failure modes matter most and both are silent: an explicitly-exempt (0%)
 * product falling through to a fallback rate and being taxed, and a line marked
 * non-taxable being taxed because nothing ever read the flag.
 *
 * The chain now has ONE implementation — `resolveLineGstRates`, which every
 * order, invoice and draft path calls. `resolveGstRate` and `resolveLineGstRate`
 * delegate to it, so the priority assertions below pin the code that actually
 * prices invoices rather than a parallel copy of it.
 */
describe('TaxResolverService', () => {
  let service: TaxResolverService;
  let prisma: {
    organizationSettings: { findUnique: jest.Mock };
    productCollection: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    productTypeTaxRate: { findMany: jest.Mock };
    stateTaxRate: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      organizationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      productCollection: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      productTypeTaxRate: { findMany: jest.fn().mockResolvedValue([]) },
      stateTaxRate: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaxResolverService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(TaxResolverService);
  });

  describe('variant override (rung 0)', () => {
    const line = (variantGstRate: number | null, productGstRate: number | null) => ({
      productId: 'p1',
      variantGstRate,
      productGstRate,
    });

    it('takes the variant rate above the product rate', async () => {
      await expect(
        service.resolveLineGstRates('org1', '27', [line(5, 18)]),
      ).resolves.toEqual([5]);
      expect(prisma.productCollection.findMany).not.toHaveBeenCalled();
    });

    it('treats an explicit 0% variant as EXEMPT even when the product is 18%', async () => {
      await expect(
        service.resolveLineGstRates('org1', '27', [line(0, 18)]),
      ).resolves.toEqual([0]);
    });

    it('inherits the product rate when the variant rate is null', async () => {
      await expect(
        service.resolveLineGstRates('org1', '27', [line(null, 12)]),
      ).resolves.toEqual([12]);
    });

    it('falls through the whole chain when both are null', async () => {
      prisma.stateTaxRate.findFirst.mockResolvedValue({ gstRate: '18.00' });
      await expect(
        service.resolveLineGstRates('org1', '27', [line(null, null)]),
      ).resolves.toEqual([18]);
      expect(prisma.stateTaxRate.findFirst).toHaveBeenCalled();
    });

    it('still yields 0% for a non-taxable line regardless of the override', async () => {
      await expect(
        service.resolveLineGstRates('org1', '27', [
          { ...line(5, 18), variantTaxable: false },
        ]),
      ).resolves.toEqual([0]);
    });
  });

  describe('resolveGstRate priority chain', () => {
    it('takes the product rate above everything else', async () => {
      await expect(service.resolveGstRate('org1', 'p1', 18, '27')).resolves.toBe(18);
      // Nothing further should even be queried.
      expect(prisma.productCollection.findMany).not.toHaveBeenCalled();
      expect(prisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
    });

    it('treats an explicit 0% product as EXEMPT and stops there', async () => {
      // The distinction between null (unset) and 0 (exempt) is the whole reason
      // callers pass toNullableNumber. Treating 0 as "unset" made exempt goods
      // fall through and get taxed at a fallback rate.
      prisma.stateTaxRate.findFirst.mockResolvedValue({ gstRate: '18.00' });

      await expect(service.resolveGstRate('org1', 'p1', 0, '27')).resolves.toBe(0);
      expect(prisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
    });

    it('falls to the HIGHEST collection override', async () => {
      // Conservative on purpose: under-charging tax is the worse error.
      prisma.productCollection.findMany.mockResolvedValue([
        { productId: 'p1', collection: { taxOverride: { gstRate: '5.00' } } },
        { productId: 'p1', collection: { taxOverride: { gstRate: '12.00' } } },
      ]);

      await expect(service.resolveGstRate('org1', 'p1', null, '27')).resolves.toBe(12);
    });

    it('falls to the product-type rate, then the state rate', async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: 'p1', productType: 'T-Shirts' },
      ]);
      prisma.productTypeTaxRate.findMany.mockResolvedValue([
        { productType: 'T-Shirts', gstRate: '12.00' },
      ]);

      await expect(service.resolveGstRate('org1', 'p1', null, '27')).resolves.toBe(12);

      prisma.productTypeTaxRate.findMany.mockResolvedValue([]);
      prisma.stateTaxRate.findFirst.mockResolvedValue({ gstRate: '18.00' });

      await expect(service.resolveGstRate('org1', 'p1', null, '27')).resolves.toBe(18);
    });

    it('resolves to 0 when nothing is configured anywhere', async () => {
      await expect(service.resolveGstRate('org1', 'p1', null, '27')).resolves.toBe(0);
    });

    it('scopes the collection and product lookups to the organization', async () => {
      // Only the nested taxOverride was org-filtered; the outer queries relied
      // on productId having come from an org-scoped read. One refactor away
      // from resolving a rate off another tenant's data.
      await service.resolveGstRate('org1', 'p1', null, '27');

      expect(prisma.productCollection.findMany.mock.calls[0][0].where).toEqual({
        productId: { in: ['p1'] },
        collection: { organizationId: 'org1' },
      });
      expect(prisma.product.findMany.mock.calls[0][0].where).toEqual({
        id: { in: ['p1'] },
        organizationId: 'org1',
      });
    });
  });

  describe('resolveLineGstRate', () => {
    it('returns 0 without consulting the chain when the LINE is not taxable', async () => {
      const rate = await service.resolveLineGstRate('org1', {
        productId: 'p1',
        productGstRate: 18,
        placeOfSupplyCode: '27',
        lineTaxable: false,
      });

      expect(rate).toBe(0);
    });

    it('returns 0 when the VARIANT is not taxable', async () => {
      const rate = await service.resolveLineGstRate('org1', {
        productId: 'p1',
        productGstRate: 18,
        placeOfSupplyCode: '27',
        variantTaxable: false,
      });

      expect(rate).toBe(0);
    });

    it('resolves normally when both flags are taxable or absent', async () => {
      await expect(
        service.resolveLineGstRate('org1', {
          productId: 'p1',
          productGstRate: 18,
          placeOfSupplyCode: '27',
          lineTaxable: true,
          variantTaxable: true,
        }),
      ).resolves.toBe(18);

      // Absent flags must NOT exempt: a Shopify line whose variant relation did
      // not resolve would otherwise silently go out untaxed.
      await expect(
        service.resolveLineGstRate('org1', {
          productId: 'p1',
          productGstRate: 18,
          placeOfSupplyCode: '27',
        }),
      ).resolves.toBe(18);
    });
  });

  /**
   * The batch path is what every real sale goes through, and a batch rewrite has
   * two failure modes a per-line loop cannot have: rates crossing between lines,
   * and the returned array falling out of step with the input once some lines
   * are answered without a query. Both are silent and both misprice an invoice.
   */
  describe('resolveLineGstRates', () => {
    it('issues a FIXED number of queries regardless of line count', async () => {
      // The reason this method exists. Twenty lines used to mean ~80 sequential
      // round trips, each on a second pooled connection held alongside the
      // caller's open transaction.
      const lines = Array.from({ length: 20 }, (_, i) => ({
        productId: 'p' + i,
        productGstRate: null,
      }));

      await service.resolveLineGstRates('org1', '27', lines);

      expect(prisma.productCollection.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.stateTaxRate.findFirst).toHaveBeenCalledTimes(1);
      // Not called at all here: no product resolved to a product type.
      expect(prisma.productTypeTaxRate.findMany).not.toHaveBeenCalled();
    });

    it('keeps each line on its OWN product rate', async () => {
      // Cross-talk between lines is the batch-specific hazard: one map lookup
      // keyed wrong and every line silently takes the first product's rate.
      prisma.productCollection.findMany.mockResolvedValue([
        { productId: 'p1', collection: { taxOverride: { gstRate: '5.00' } } },
        { productId: 'p2', collection: { taxOverride: { gstRate: '12.00' } } },
      ]);
      prisma.stateTaxRate.findFirst.mockResolvedValue({ gstRate: '18.00' });

      const rates = await service.resolveLineGstRates('org1', '27', [
        { productId: 'p1', productGstRate: null },
        { productId: 'p2', productGstRate: null },
        { productId: 'p3', productGstRate: null }, // no override -> state rate
      ]);

      expect(rates).toEqual([5, 12, 18]);
    });

    it('keeps the result array in step with the input when lines skip the chain', async () => {
      // Lines answered without a query (non-taxable, or an explicit product
      // rate) are not in `pending`. If the fold wrote results positionally
      // against `pending` instead of the original index, every line after the
      // first exempt one would take its neighbour's rate.
      prisma.stateTaxRate.findFirst.mockResolvedValue({ gstRate: '18.00' });

      const rates = await service.resolveLineGstRates('org1', '27', [
        { productId: 'p1', productGstRate: null }, // -> state 18
        { productId: 'p2', productGstRate: 5 }, // explicit, no query
        { productId: 'p3', productGstRate: null, variantTaxable: false }, // exempt
        { productId: 'p4', productGstRate: null }, // -> state 18
        { productId: 'p5', productGstRate: 0 }, // explicit 0% = exempt
      ]);

      expect(rates).toEqual([18, 5, 0, 18, 0]);
    });

    it('maps product-type rates per product, not per line', async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: 'p1', productType: 'T-Shirts' },
        { id: 'p2', productType: 'Jewellery' },
        { id: 'p3', productType: null },
      ]);
      prisma.productTypeTaxRate.findMany.mockResolvedValue([
        { productType: 'T-Shirts', gstRate: '12.00' },
        { productType: 'Jewellery', gstRate: '3.00' },
      ]);
      prisma.stateTaxRate.findFirst.mockResolvedValue({ gstRate: '18.00' });

      const rates = await service.resolveLineGstRates('org1', '27', [
        { productId: 'p1', productGstRate: null },
        { productId: 'p2', productGstRate: null },
        { productId: 'p3', productGstRate: null }, // no type -> state rate
      ]);

      expect(rates).toEqual([12, 3, 18]);
    });

    it('deduplicates product ids so a repeated product is fetched once', async () => {
      await service.resolveLineGstRates('org1', '27', [
        { productId: 'p1', productGstRate: null },
        { productId: 'p1', productGstRate: null },
        { productId: 'p1', productGstRate: null },
      ]);

      expect(prisma.product.findMany.mock.calls[0][0].where.id.in).toEqual(['p1']);
    });

    it('issues NO rate queries when every line is answered outright', async () => {
      const rates = await service.resolveLineGstRates('org1', '27', [
        { productId: 'p1', productGstRate: 18 },
        { productId: 'p2', productGstRate: 0 },
        { productId: 'p3', productGstRate: null, lineTaxable: false },
      ]);

      expect(rates).toEqual([18, 0, 0]);
      expect(prisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
    });

    it('runs on the CALLER transaction client when one is passed', async () => {
      // The correctness half of this fix: rates read on `this.prisma` execute
      // outside the caller's Serializable snapshot, so an invoice could be
      // priced with rates its own transaction cannot see.
      const tx = {
        organizationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        productCollection: { findMany: jest.fn().mockResolvedValue([]) },
        product: { findMany: jest.fn().mockResolvedValue([]) },
        productTypeTaxRate: { findMany: jest.fn().mockResolvedValue([]) },
        stateTaxRate: {
          findFirst: jest.fn().mockResolvedValue({ gstRate: '28.00' }),
        },
      };

      const rates = await service.resolveLineGstRates(
        'org1',
        '27',
        [{ productId: 'p1', productGstRate: null }],
        tx as never,
      );

      expect(rates).toEqual([28]);
      expect(tx.stateTaxRate.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
    });
  });

  /**
   * A composition taxpayer cannot collect tax on any supply (CGST Act section
   * 10), and every path that charges tax prices its lines here — offline
   * orders and the till, drafts, invoices.
   */
  describe('composition scheme', () => {
    it('gives every line 0%, whatever the product, variant or state says', async () => {
      prisma.organizationSettings.findUnique.mockResolvedValue({ taxSettings: { composition: true } });
      prisma.stateTaxRate.findFirst.mockResolvedValue({ gstRate: '18.00' });

      const rates = await service.resolveLineGstRates('org1', '29', [
        { productId: 'p1', productGstRate: 18 },
        { productId: 'p2', variantGstRate: 12, productGstRate: 5 },
        { productId: 'p3', productGstRate: null },
      ]);

      expect(rates).toEqual([0, 0, 0]);
      // Nothing of the chain is even read.
      expect(prisma.stateTaxRate.findFirst).not.toHaveBeenCalled();
      expect(prisma.productCollection.findMany).not.toHaveBeenCalled();
    });

    it('reads the switch on the caller transaction, for its own organization', async () => {
      const tx = {
        organizationSettings: {
          findUnique: jest.fn().mockResolvedValue({ taxSettings: { composition: true } }),
        },
      };

      await expect(
        service.resolveLineGstRates('org1', '29', [{ productId: 'p1', productGstRate: 18 }], tx as never),
      ).resolves.toEqual([0]);
      expect(tx.organizationSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org1' } }),
      );
      expect(prisma.organizationSettings.findUnique).not.toHaveBeenCalled();
    });

    it('charges the usual rates once the switch is off', async () => {
      prisma.organizationSettings.findUnique.mockResolvedValue({ taxSettings: { composition: false } });

      await expect(
        service.resolveLineGstRates('org1', '29', [{ productId: 'p1', productGstRate: 18 }]),
      ).resolves.toEqual([18]);
    });
  });
});
