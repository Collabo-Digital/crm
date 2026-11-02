import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  IMAGE_STORAGE,
  type IImageStorage,
  type UploadInput,
} from '../product/image-storage/image-storage.interface';
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
      providers: [
        OrganizationSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IMAGE_STORAGE, useValue: {} },
      ],
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
    const service = new OrganizationSettingsService(
      prisma as unknown as PrismaService,
      {} as IImageStorage,
    );
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

/**
 * The stored row as a mutable object the upsert writes back to, so a spec can
 * read what a later request would see.
 */
function settingsHarness(stored: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { ...stored };
  const prisma = {
    organizationSettings: {
      findUnique: jest.fn(() => Promise.resolve(row)),
      upsert: jest.fn(({ update }: { update: Record<string, unknown> }) => {
        Object.assign(row, update);
        return Promise.resolve(row);
      }),
    },
    order: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const storage = {
    upload: jest.fn((input: UploadInput) => {
      const file = `f1${input.mimeType === 'image/png' ? '.png' : '.jpg'}`;
      return Promise.resolve({
        url: `http://api.test/uploads/products/${input.orgId}/${file}`,
        storageKey: `${input.orgId}/${file}`,
        mimeType: input.mimeType,
        size: input.size,
      });
    }),
    delete: jest.fn(),
    read: jest.fn(),
  };
  const service = new OrganizationSettingsService(prisma as unknown as PrismaService, storage);
  return { service, prisma, storage, row };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

/** A Multer upload. `mimetype` and the name are what the browser claimed. */
const file = (buffer: Buffer, claimed: { originalname?: string; mimetype?: string } = {}) => ({
  buffer,
  size: buffer.length,
  originalname: claimed.originalname ?? 'logo.png',
  mimetype: claimed.mimetype ?? 'image/png',
});

/** `head` padded with zeros to `size` bytes. */
const sized = (head: Buffer, size: number) => Buffer.concat([head, Buffer.alloc(size - head.length)]);

describe('OrganizationSettingsService invoice design', () => {
  const ORG = 'org_1';
  const SIGNATURE = { storageKey: 'org_1/sig.png', url: 'http://api.test/uploads/products/org_1/sig.png' };

  it('reads it with the other domains, defaults filled in', async () => {
    const { service } = settingsHarness({ invoiceSettings: { theme: 'classic' } });

    const settings = await service.get(ORG);

    expect(settings.invoiceSettings).toEqual(expect.objectContaining({ theme: 'classic', footerNote: 'Thank you for shopping with us.' }));
  });

  it('patches only what was sent, keeping the terms and the uploaded signature', async () => {
    const { service, row } = settingsHarness({
      invoiceSettings: { terms: 'Goods once sold are exchanged within 7 days.', signature: SIGNATURE },
    });

    const next = await service.updateInvoiceSettings(ORG, { theme: 'classic', brandColor: '#1F6F5C' });

    expect(next).toEqual(
      expect.objectContaining({
        theme: 'classic',
        brandColor: '#1F6F5C',
        terms: 'Goods once sold are exchanged within 7 days.',
        signature: SIGNATURE,
      }),
    );
    expect(row.invoiceSettings).toEqual(next);
  });
});

describe('OrganizationSettingsService composition and e-invoicing', () => {
  const ORG = 'org_1';
  const CONFLICT =
    "Composition and e-invoicing can't both be on: the composition scheme ends far below the e-invoicing limit.";

  it('refuses both on in one patch, and writes nothing', async () => {
    const { service, prisma } = settingsHarness({ taxSettings: {} });

    await expect(service.updateTaxSettings(ORG, { composition: true, eInvoicing: true })).rejects.toThrow(CONFLICT);
    expect(prisma.organizationSettings.upsert).not.toHaveBeenCalled();
  });

  it('refuses turning one on while the other is saved on', async () => {
    const einvoicing = settingsHarness({ taxSettings: { eInvoicing: true } });
    await expect(einvoicing.service.updateTaxSettings(ORG, { composition: true })).rejects.toThrow(CONFLICT);

    const composition = settingsHarness({ taxSettings: { composition: true } });
    await expect(composition.service.updateTaxSettings(ORG, { eInvoicing: true })).rejects.toThrow(CONFLICT);
  });

  it('allows switching from one to the other in one patch, keeping the other tax settings', async () => {
    const { service } = settingsHarness({ taxSettings: { eInvoicing: true, b2cLargeThreshold: 250000 } });

    const next = await service.updateTaxSettings(ORG, { composition: true, eInvoicing: false });

    expect(next).toEqual(expect.objectContaining({ composition: true, eInvoicing: false, b2cLargeThreshold: 250000 }));
  });
});

/**
 * Uploads are checked by their first bytes: the browser's MIME type and the
 * file name are only claims. PDFs embed what is stored here.
 */
describe('OrganizationSettingsService logo and signature uploads', () => {
  const ORG = 'org_1';

  it('stores a logo and points the store profile at it, keeping the rest of the profile', async () => {
    const { service, storage, row } = settingsHarness({ storeProfileSettings: { storeName: 'Saanjh', supportPhone: '+91 98450 00000' } });

    // A real PNG the browser called something else is stored as a PNG.
    const profile = await service.uploadLogo(ORG, file(PNG, { originalname: 'logo.gif', mimetype: 'image/gif' }));

    expect(storage.upload).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, mimeType: 'image/png' }));
    expect(profile).toEqual(
      expect.objectContaining({
        storeName: 'Saanjh',
        supportPhone: '+91 98450 00000',
        logoUrl: 'http://api.test/uploads/products/org_1/f1.png',
        logoStorageKey: 'org_1/f1.png',
      }),
    );
    expect(row.storeProfileSettings).toEqual(profile);
  });

  it('takes a JPEG logo of exactly 1 MB', async () => {
    const { service, storage } = settingsHarness();

    await service.uploadLogo(ORG, file(sized(JPEG, 1024 * 1024), { originalname: 'logo.jpg', mimetype: 'image/jpeg' }));

    expect(storage.upload).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/jpeg' }));
  });

  it.each([
    ['a GIF renamed .png', file(GIF), 'The logo must be a PNG or JPEG image.'],
    ['an SVG', file(SVG, { originalname: 'logo.svg', mimetype: 'image/svg+xml' }), 'The logo must be a PNG or JPEG image.'],
    ['a PNG over 1 MB', file(sized(PNG, 1024 * 1024 + 1)), 'The logo can be at most 1 MB.'],
    ['an empty file', file(Buffer.alloc(0)), 'Choose an image to upload.'],
  ])('refuses %s as a logo, storing and saving nothing', async (_name, upload, message) => {
    const { service, storage, prisma } = settingsHarness();

    await expect(service.uploadLogo(ORG, upload)).rejects.toThrow(message);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.organizationSettings.upsert).not.toHaveBeenCalled();
  });

  it('refuses a request with no file', async () => {
    const { service } = settingsHarness();

    await expect(service.uploadLogo(ORG, undefined)).rejects.toThrow('Choose an image to upload.');
  });

  it('removes the logo but keeps the file, which issued invoices may print', async () => {
    const { service, storage } = settingsHarness({
      storeProfileSettings: { storeName: 'Saanjh', logoUrl: 'http://api.test/uploads/products/org_1/a.png', logoStorageKey: 'org_1/a.png' },
    });

    const profile = await service.removeLogo(ORG);

    expect(profile).toEqual(expect.objectContaining({ storeName: 'Saanjh', logoUrl: '', logoStorageKey: '' }));
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('stores a signature on the invoice design, keeping the rest of it', async () => {
    const { service } = settingsHarness({ invoiceSettings: { signatureMode: 'image', signatoryName: 'Asha Rao' } });

    const design = await service.uploadSignature(ORG, file(sized(PNG, 300 * 1024), { originalname: 'sign.png' }));

    expect(design).toEqual(
      expect.objectContaining({
        signatureMode: 'image',
        signatoryName: 'Asha Rao',
        signature: { storageKey: 'org_1/f1.png', url: 'http://api.test/uploads/products/org_1/f1.png' },
      }),
    );
  });

  it.each([
    ['a GIF renamed .png', file(GIF, { originalname: 'sign.png' }), 'The signature must be a PNG or JPEG image.'],
    ['an SVG', file(SVG, { originalname: 'sign.svg', mimetype: 'image/svg+xml' }), 'The signature must be a PNG or JPEG image.'],
    ['a PNG over 300 KB', file(sized(PNG, 300 * 1024 + 1), { originalname: 'sign.png' }), 'The signature can be at most 300 KB.'],
  ])('refuses %s as a signature', async (_name, upload, message) => {
    const { service, storage } = settingsHarness();

    await expect(service.uploadSignature(ORG, upload)).rejects.toThrow(message);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('removes the signature but keeps the file', async () => {
    const { service, storage } = settingsHarness({
      invoiceSettings: { signatureMode: 'image', signature: { storageKey: 'org_1/s.png', url: 'http://api.test/s.png' } },
    });

    const design = await service.removeSignature(ORG);

    expect(design.signature).toBeNull();
    expect(design.signatureMode).toBe('image');
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

/**
 * PDFs embed only an uploaded logo, never a URL a member typed. A typed URL
 * therefore detaches the stored file, and the PDF prints the trading name.
 */
describe('OrganizationSettingsService store profile logo URL', () => {
  const ORG = 'org_1';
  const UPLOADED = { logoUrl: 'http://api.test/uploads/products/org_1/a.png', logoStorageKey: 'org_1/a.png' };

  it('clears the stored file when a different URL is typed', async () => {
    const { service } = settingsHarness({ storeProfileSettings: { storeName: 'Saanjh', ...UPLOADED } });

    const profile = await service.updateStoreProfileSettings(ORG, { logoUrl: 'https://cdn.example.com/logo.png' });

    expect(profile).toEqual(expect.objectContaining({ logoUrl: 'https://cdn.example.com/logo.png', logoStorageKey: '' }));
  });

  it('clears it when the URL is cleared', async () => {
    const { service } = settingsHarness({ storeProfileSettings: UPLOADED });

    expect((await service.updateStoreProfileSettings(ORG, { logoUrl: '' })).logoStorageKey).toBe('');
  });

  it('keeps it when the form sends the uploaded URL back, or leaves the logo alone', async () => {
    const { service } = settingsHarness({ storeProfileSettings: UPLOADED });

    expect((await service.updateStoreProfileSettings(ORG, { logoUrl: UPLOADED.logoUrl })).logoStorageKey).toBe('org_1/a.png');
    expect((await service.updateStoreProfileSettings(ORG, { storeName: 'Saanjh Living' })).logoStorageKey).toBe('org_1/a.png');
  });
});
