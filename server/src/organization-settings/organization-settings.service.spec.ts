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

  beforeEach(async () => {
    executeRaw = jest.fn().mockResolvedValue(42);
    findUnique = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationSettingsService,
        {
          provide: PrismaService,
          useValue: {
            $executeRaw: executeRaw,
            organizationSettings: {
              findUnique,
              upsert: jest.fn().mockResolvedValue({}),
            },
          },
        },
      ],
    }).compile();

    service = module.get(OrganizationSettingsService);
  });

  it('off → on flags the org’s synced products that carry generated barcodes', async () => {
    stored({ pushGeneratedBarcodes: false });
    const next = await service.updateInventorySettings(ORG, { pushGeneratedBarcodes: true });
    expect(next.pushGeneratedBarcodes).toBe(true);
    expect(backlogStamps()).toEqual([ORG]);
  });

  it('treats a never-saved row as off, so the first switch-on flags too', async () => {
    stored(null);
    await service.updateInventorySettings(ORG, { pushGeneratedBarcodes: true });
    expect(backlogStamps()).toEqual([ORG]);
  });

  it('on → on does nothing extra', async () => {
    stored({ pushGeneratedBarcodes: true });
    await service.updateInventorySettings(ORG, { pushGeneratedBarcodes: true });
    expect(backlogStamps()).toEqual([]);
  });

  it('on → off does nothing extra: there is nothing to send', async () => {
    stored({ pushGeneratedBarcodes: true });
    await service.updateInventorySettings(ORG, { pushGeneratedBarcodes: false });
    expect(backlogStamps()).toEqual([]);
  });

  it('an unrelated inventory patch leaves the flag — and the catalogue — alone', async () => {
    stored({ pushGeneratedBarcodes: false, requireScanToPick: false });
    const next = await service.updateInventorySettings(ORG, { requireScanToPick: true });
    expect(next.pushGeneratedBarcodes).toBe(false);
    expect(backlogStamps()).toEqual([]);
  });
});
