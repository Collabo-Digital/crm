import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';
import { SkuGeneratorService } from './sku-generator.service';

/**
 * The counts behind the merchant-facing "Product codes" dialog.
 *
 * These replaced three toolbar buttons whose counts were derived from the
 * current page's SELECTION while the buttons themselves acted org-wide — so a
 * button could say "12" and rewrite three hundred rows. The contract that
 * matters is therefore not the SQL text but the claim each figure makes:
 * every count is the exact target set of one action, so a zero means that
 * action has nothing to do and is not offered at all.
 *
 * The predicate is asserted against the SQL because it is the whole safety
 * story for the destructive action: replacing a SHOPIFY barcode destroys a
 * real GTIN, and replacing a MANUAL one destroys something a person typed.
 */
describe('SkuGeneratorService.codeStatus', () => {
  let service: SkuGeneratorService;
  let queryRaw: jest.Mock;

  const ORG = 'org_1';

  /** The interpolated SQL, whitespace-collapsed for readable assertions. */
  const sql = () => {
    const arg = queryRaw.mock.calls[0][0] as Prisma.Sql;
    return arg.strings.join(' ').replace(/\s+/g, ' ');
  };

  beforeEach(async () => {
    queryRaw = jest.fn().mockResolvedValue([
      {
        total: BigInt(120),
        missing_sku: BigInt(12),
        missing_barcode: BigInt(8),
        long_barcode: BigInt(40),
      },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkuGeneratorService,
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: queryRaw,
            organization: {
              findUnique: jest
                .fn()
                .mockResolvedValue({ slug: 'damo-dar', name: 'Damo Dar' }),
            },
          },
        },
        {
          provide: OrganizationSettingsService,
          useValue: {
            getInventorySettings: jest.fn().mockResolvedValue({ skuPrefix: '' }),
          },
        },
      ],
    }).compile();

    service = module.get(SkuGeneratorService);
  });

  it('returns the four counts as plain numbers', async () => {
    // Postgres COUNT comes back as BigInt; JSON.stringify throws on one, so a
    // leak here would 500 the endpoint rather than merely look wrong.
    const res = await service.codeStatus(ORG);

    expect(res).toMatchObject({
      totalVariants: 120,
      missingSku: 12,
      missingBarcode: 8,
      longBarcode: 40,
    });
    const { skuPrefix, ...counts } = res;
    for (const v of Object.values(counts)) expect(typeof v).toBe('number');
  });

  it('scopes every count to the org and excludes deleted products', async () => {
    await service.codeStatus(ORG);

    expect(sql()).toContain('v."organization_id" =');
    expect(sql()).toContain('p."deleted_at" IS NULL');
    expect(queryRaw.mock.calls[0][0].values).toEqual([ORG]);
  });

  it('counts a missing code as either NULL or empty string', async () => {
    // Both states exist in the data: a variant created without one is NULL, a
    // cleared field saves as ''. Counting only NULL understated every figure.
    await service.codeStatus(ORG);

    expect(sql()).toContain(`v."sku" IS NULL OR v."sku" = ''`);
    expect(sql()).toContain(`v."barcode" IS NULL OR v."barcode" = ''`);
  });

  it('only counts GENERATED barcodes as replaceable', async () => {
    // The safety property of the Shorten action. SHOPIFY is a real GTIN and
    // MANUAL was typed by a person; neither may ever be in scope, and neither
    // may be reached by widening this predicate later.
    await service.codeStatus(ORG);

    expect(sql()).toContain(`v."barcode_source" = 'GENERATED'`);
    expect(sql()).not.toContain(`'SHOPIFY'`);
    expect(sql()).not.toContain(`'MANUAL'`);
  });

  it('excludes barcodes that are already the 6-digit short form', async () => {
    // Without this the count never reaches zero, the button never stops
    // offering itself, and pressing it reports "Generated 0" — the exact
    // behaviour this work removed.
    await service.codeStatus(ORG);

    expect(sql()).toContain(`v."barcode" !~ '^[0-9]{6}$'`);
  });

  it('returns the RESOLVED prefix, not the raw setting', async () => {
    // Most orgs leave skuPrefix empty and fall back to a mnemonic of their
    // name. Returning the empty setting made the dialog preview a generated
    // SKU as "———-SAR-001", which reads as a broken preview rather than as
    // "none configured". The client must not re-derive this rule.
    const res = await service.codeStatus(ORG);

    expect(res.skuPrefix).toBe('DAM');
  });

  it('reports zeros rather than throwing when the org has no variants', async () => {
    // A brand-new org: the aggregate still returns one row, but guard the
    // empty-result path too — a throw here would break the dialog on the one
    // org for which it has nothing to say.
    queryRaw.mockResolvedValue([]);

    await expect(service.codeStatus(ORG)).resolves.toMatchObject({
      totalVariants: 0,
      missingSku: 0,
      missingBarcode: 0,
      longBarcode: 0,
    });
  });
});
