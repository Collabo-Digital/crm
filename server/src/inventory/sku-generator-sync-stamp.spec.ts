import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { SkuGeneratorService } from './sku-generator.service';

/**
 * The generators write straight to the variant row, so they must tell the
 * sync layer themselves. `metadata.shopifySync.status` is the only thing
 * "Sync Now" reads: a SYNCED product is skipped, an OUT_OF_SYNC one is
 * pushed. On 2026-10-08 Shrishti had every barcode generated, the "send
 * generated barcodes" setting on, and two Sync Now runs that each found "no
 * products pending" — the generators had never flipped a single status.
 *
 * What is pinned here is the contract, not the SQL: which products get
 * flagged, and when the flag is withheld because the push would send nothing.
 */
describe('SkuGeneratorService — flagging products for push', () => {
  let service: SkuGeneratorService;
  let executeRaw: jest.Mock;
  let getInventorySettings: jest.Mock;
  let findMany: jest.Mock;

  const ORG = 'org_1';

  const variant = (id: string, productId: string, extra: Record<string, unknown> = {}) => ({
    id,
    productId,
    sku: null,
    barcode: null,
    option1: null,
    option2: null,
    option3: null,
    product: { title: 'Saree' },
    ...extra,
  });

  /** Product ids bound into the stamp UPDATE, in call order. */
  const stampedIds = (): string[][] =>
    executeRaw.mock.calls
      .map((c) => c[0] as Prisma.Sql)
      // claimSequence also goes through $executeRaw, as a tagged template
      // (a strings array with no `.sql`); only Prisma.Sql values are stamps.
      .filter((sql) => typeof sql?.sql === 'string' && sql.sql.includes('OUT_OF_SYNC'))
      .map((sql) => (sql.values[0] as string[]).slice().sort());

  beforeEach(async () => {
    executeRaw = jest.fn().mockResolvedValue(1);
    getInventorySettings = jest.fn().mockResolvedValue({
      skuPrefix: 'SJ',
      pushGeneratedBarcodes: false,
    });
    findMany = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkuGeneratorService,
        {
          provide: PrismaService,
          useValue: {
            $executeRaw: executeRaw,
            // claimSequence: the sequence row arrives back as a bigint.
            $queryRaw: jest.fn().mockResolvedValue([{ next_seq: BigInt(100) }]),
            productVariant: {
              findMany,
              findFirst: jest.fn().mockResolvedValue(null),
              update: jest.fn().mockResolvedValue({}),
            },
            organization: {
              findUnique: jest.fn().mockResolvedValue({ slug: 'sj', name: 'SJ' }),
            },
          },
        },
        { provide: OrganizationSettingsService, useValue: { getInventorySettings } },
      ],
    }).compile();

    service = module.get(SkuGeneratorService);
  });

  describe('generateSkus', () => {
    it('flags each written variant’s product once, SKUs being always pushed', async () => {
      // loadTargets, then the collision probe set.
      findMany
        .mockResolvedValueOnce([
          variant('v1', 'p1'),
          variant('v2', 'p1'),
          variant('v3', 'p2'),
        ])
        .mockResolvedValueOnce([]);

      const res = await service.generateSkus(ORG, { filter: 'missing-sku' });

      expect(res.generated).toBe(3);
      expect(stampedIds()).toEqual([['p1', 'p2']]);
      // Never consults the barcode flag: a SKU goes out regardless.
      expect(getInventorySettings).toHaveBeenCalledTimes(1); // resolvePrefix only
    });

    it('does not stamp when nothing was written', async () => {
      findMany.mockResolvedValueOnce([]);
      await service.generateSkus(ORG, { filter: 'missing-sku' });
      expect(stampedIds()).toEqual([]);
    });
  });

  describe('generateBarcodes (short codes)', () => {
    it('flags the products when the org sends generated barcodes to Shopify', async () => {
      getInventorySettings.mockResolvedValue({ skuPrefix: 'SJ', pushGeneratedBarcodes: true });
      findMany
        .mockResolvedValueOnce([variant('v1', 'p1'), variant('v2', 'p2')])
        .mockResolvedValueOnce([]); // existing-code probe set

      const res = await service.generateBarcodes(ORG, { filter: 'missing-barcode' });

      expect(res.generated).toBe(2);
      expect(stampedIds()).toEqual([['p1', 'p2']]);
    });

    it('withholds the flag when the push would not carry the code anyway', async () => {
      // pushGeneratedBarcodes is off: the push gate drops GENERATED codes, so
      // an amber pill would promise a push that changes nothing. The backlog
      // is flagged later, when the setting is switched on.
      getInventorySettings.mockResolvedValue({ skuPrefix: 'SJ', pushGeneratedBarcodes: false });
      findMany
        .mockResolvedValueOnce([variant('v1', 'p1')])
        .mockResolvedValueOnce([]);

      const res = await service.generateBarcodes(ORG, { filter: 'missing-barcode' });

      expect(res.generated).toBe(1);
      expect(stampedIds()).toEqual([]);
    });

    it('flags only products that actually received a code', async () => {
      getInventorySettings.mockResolvedValue({ skuPrefix: 'SJ', pushGeneratedBarcodes: true });
      findMany
        .mockResolvedValueOnce([variant('v1', 'p1'), variant('v2', 'p2')])
        .mockResolvedValueOnce([]);
      // v2's candidate is claimed concurrently → conflict, not written.
      const prisma = (service as unknown as { prisma: { productVariant: { findFirst: jest.Mock } } })
        .prisma;
      prisma.productVariant.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'someone-else' });

      const res = await service.generateBarcodes(ORG, { filter: 'missing-barcode' });

      expect(res.generated).toBe(1);
      expect(res.conflicts).toHaveLength(1);
      expect(stampedIds()).toEqual([['p1']]);
    });
  });

  describe('generateBarcodes (format: sku)', () => {
    it('applies the same gate as the short-code path', async () => {
      getInventorySettings.mockResolvedValue({ skuPrefix: 'SJ', pushGeneratedBarcodes: true });
      findMany.mockResolvedValueOnce([
        variant('v1', 'p1', { sku: 'SJ-SAR-001' }),
        variant('v2', 'p2'), // no SKU → skipped, so p2 must not be flagged
      ]);

      const res = await service.generateBarcodes(ORG, { filter: 'missing-barcode', format: 'sku' });

      expect(res.generated).toBe(1);
      expect(stampedIds()).toEqual([['p1']]);
    });
  });
});
