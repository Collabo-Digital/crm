import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { OrganizationSettingsService } from './organization-settings.service';

/**
 * `pushGeneratedBarcodes` is the one setting whose change has a side effect
 * beyond the settings row. Switching it on means "there is now something to
 * send" for every synced product carrying a generated barcode, and nothing
 * else ever re-flags those rows — so the toggle flags them itself.
 */
describe('OrganizationSettingsService.updateInventorySettings — barcode backlog', () => {
  let service: OrganizationSettingsService;
  let executeRaw: jest.Mock;
  let findUnique: jest.Mock;

  const ORG = 'org_1';

  const stored = (inventorySettings: Record<string, unknown> | null) =>
    findUnique.mockResolvedValue(inventorySettings ? { inventorySettings } : null);

  /** The org-wide stamp statements issued, by bound org id. */
  const backlogStamps = (): string[] =>
    executeRaw.mock.calls
      .map((c) => c[0] as Prisma.Sql)
      .filter((sql) => typeof sql?.sql === 'string' && sql.sql.includes('barcode_source'))
      .map((sql) => sql.values[0] as string);

  let upsert: jest.Mock;
  let transaction: jest.Mock;

  beforeEach(async () => {
    executeRaw = jest.fn().mockResolvedValue(42);
    findUnique = jest.fn();
    upsert = jest.fn().mockResolvedValue({});

    // The interactive-transaction client is the same mock, so the spec can
    // see which calls went through the transaction and which did not.
    const prisma = {
      $executeRaw: executeRaw,
      organizationSettings: { findUnique, upsert },
    };
    transaction = jest.fn((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
    Object.assign(prisma, { $transaction: transaction });

    const module: TestingModule = await Test.createTestingModule({
      providers: [OrganizationSettingsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(OrganizationSettingsService);
  });

  it('off → on flags the org’s synced products that carry generated barcodes', async () => {
    stored({ pushGeneratedBarcodes: false });
    const next = await service.updateInventorySettings(ORG, {
      pushGeneratedBarcodes: true,
    });
    expect(next.pushGeneratedBarcodes).toBe(true);
    expect(backlogStamps()).toEqual([ORG]);
    // Settings write and sweep commit together, or not at all.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('does not persist the flag if the backlog sweep fails', async () => {
    stored({ pushGeneratedBarcodes: false });
    executeRaw.mockRejectedValueOnce(new Error('deadlock detected'));
    // A real transaction rolls the upsert back; here the mock just has to
    // show the error escapes instead of being swallowed after the write.
    await expect(
      service.updateInventorySettings(ORG, {
        pushGeneratedBarcodes: true,
      }),
    ).rejects.toThrow('deadlock detected');
  });

  it('treats a never-saved row as off, so the first switch-on flags too', async () => {
    stored(null);
    await service.updateInventorySettings(ORG, {
      pushGeneratedBarcodes: true,
    });
    expect(backlogStamps()).toEqual([ORG]);
  });

  it('on → on does nothing extra, and writes outside a transaction', async () => {
    stored({ pushGeneratedBarcodes: true });
    await service.updateInventorySettings(ORG, {
      pushGeneratedBarcodes: true,
    });
    expect(backlogStamps()).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('on → off does nothing extra: there is nothing to send', async () => {
    stored({ pushGeneratedBarcodes: true });
    await service.updateInventorySettings(ORG, {
      pushGeneratedBarcodes: false,
    });
    expect(backlogStamps()).toEqual([]);
  });

  it('an unrelated inventory patch leaves the flag — and the catalogue — alone', async () => {
    stored({ pushGeneratedBarcodes: false, requireScanToPick: false });
    const next = await service.updateInventorySettings(ORG, {
      requireScanToPick: true,
    });
    expect(next.pushGeneratedBarcodes).toBe(false);
    expect(backlogStamps()).toEqual([]);
  });
});

/**
 * The order form previews totals on the basis the server will save them on,
 * and the Tax & GST screen shows what the server is going by when the
 * merchant has not chosen.
 */
describe('OrganizationSettingsService.get — whether prices include GST', () => {
  async function get(opts: { chosen?: boolean; storeTaxesIncluded?: boolean }) {
    const prisma = {
      organizationSettings: {
        findUnique: jest.fn().mockResolvedValue(
          opts.chosen === undefined ? null : { taxSettings: { pricesIncludeTax: opts.chosen } },
        ),
      },
      order: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            opts.storeTaxesIncluded === undefined ? null : { taxesIncluded: opts.storeTaxesIncluded },
          ),
      },
    };
    const service = new OrganizationSettingsService(prisma as unknown as PrismaService);
    return service.get('org_1');
  }

  it('goes by the store’s Shopify orders while nothing is chosen', async () => {
    const settings = await get({ storeTaxesIncluded: true });

    expect(settings.taxSettings.pricesIncludeTax).toBeNull();
    expect(settings.pricesIncludeTax).toEqual({ effective: true, detected: true });
  });

  it('goes by the merchant’s choice once made', async () => {
    const settings = await get({ chosen: false, storeTaxesIncluded: true });

    expect(settings.taxSettings.pricesIncludeTax).toBe(false);
    expect(settings.pricesIncludeTax).toEqual({ effective: false, detected: true });
  });

  it('reads prices as excluding GST with neither', async () => {
    const settings = await get({});

    expect(settings.pricesIncludeTax).toEqual({ effective: false, detected: null });
  });
});
