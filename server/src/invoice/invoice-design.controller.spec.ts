import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { IMAGE_STORAGE } from '../product/image-storage/image-storage.interface';
import { InvoiceDesignController } from './invoice-design.controller';
import type { DocumentModel } from './render/document-model';
import { renderDocumentPdf } from './render/document-pdf';

// The renderer is drawn on its own branch; here it hands back what it was given.
jest.mock('./render/document-pdf', () => ({ renderDocumentPdf: jest.fn() }));
const render = renderDocumentPdf as jest.Mock;
const drawn = () => (render.mock.calls[0] as [DocumentModel])[0];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

/**
 * The settings page's live preview, over HTTP: what it accepts, that it
 * answers with the PDF itself, and that the edits it is sent are drawn but
 * never saved.
 */
describe('POST /organization/settings/invoice/preview', () => {
  let app: INestApplication;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let images: { read: jest.Mock };

  beforeEach(async () => {
    render.mockReset().mockResolvedValue(Buffer.from('%PDF-1.7 preview'));
    // Reads only: a write would be a TypeError, and the test would fail.
    prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Saanjh',
          website: null,
          timezone: 'Asia/Kolkata',
          currency: 'INR',
          gstEnabled: false,
        }),
      },
      organizationSettings: {
        findUnique: jest.fn().mockResolvedValue({
          invoiceSettings: {
            theme: 'classic',
            terms: 'Saved terms',
            footerNote: 'Saved note',
          },
          taxSettings: null,
          storeProfileSettings: { logoStorageKey: 'org_1/logo.png' },
          posSettings: null,
        }),
      },
      organizationGstin: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    images = { read: jest.fn().mockResolvedValue(PNG) };
    const module = await Test.createTestingModule({
      controllers: [InvoiceDesignController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: IMAGE_STORAGE, useValue: images },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { orgId: 'org_1', role: UserRole.MANAGER };
      next();
    });
    await app.init();
  });

  afterEach(() => app.close());

  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/organization/settings/invoice/preview')
      .send(body as object)
      .responseType('blob');

  it('answers with the PDF itself, not the JSON envelope', async () => {
    const res = await post({ sample: 'tax_invoice' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Buffer.from(res.body).toString()).toBe('%PDF-1.7 preview');
  });

  it('draws the edits over the saved settings, for this preview only', async () => {
    await post({
      sample: 'tax_invoice_b2b',
      settings: {
        theme: 'modern',
        classicForB2b: false,
        brandColor: '#0f766e',
        terms: 'Edited terms',
      },
    });
    const model = drawn();
    expect(model).toMatchObject({
      kind: 'TAX_INVOICE',
      theme: 'modern',
      brandColor: '#0F766E',
      terms: ['Edited terms'],
      footer: { note: 'Saved note' },
    });
    expect(model.seller).toMatchObject({
      legalName: 'Saanjh',
      gstin: '29ABCDE1234F1Z5',
    });
    expect(prisma.organizationSettings.findUnique).toHaveBeenCalledWith({
      where: { organizationId: 'org_1' },
      select: {
        invoiceSettings: true,
        taxSettings: true,
        storeProfileSettings: true,
        posSettings: true,
      },
    });
  });

  it.each([
    'tax_invoice',
    'tax_invoice_b2b',
    'bill_of_supply',
    'credit_note',
    'bill',
  ])('draws the %s sample', async (sample) => {
    expect((await post({ sample })).status).toBe(200);
    expect(drawn().kind).toBe(
      {
        tax_invoice: 'TAX_INVOICE',
        tax_invoice_b2b: 'TAX_INVOICE',
        bill_of_supply: 'BILL_OF_SUPPLY',
        credit_note: 'CREDIT_NOTE',
        bill: 'BILL',
      }[sample],
    );
  });

  it.each([
    ['no sample', {}],
    ['a sample that does not exist', { sample: 'receipt' }],
    [
      'a colour that is not one',
      { sample: 'tax_invoice', settings: { brandColor: 'teal' } },
    ],
    [
      'a theme that does not exist',
      { sample: 'tax_invoice', settings: { theme: 'festive' } },
    ],
    [
      'a custom ID without a label',
      {
        sample: 'tax_invoice',
        settings: { businessIds: [{ type: 'CUSTOM', value: 'X-1' }] },
      },
    ],
  ])('refuses %s with a 400 and draws nothing', async (_label, body) => {
    const res = await request(app.getHttpServer())
      .post('/organization/settings/invoice/preview')
      .send(body);
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      'Invalid settings payload',
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('embeds the saved logo, read through the image storage', async () => {
    await post({ sample: 'tax_invoice' });
    expect(images.read).toHaveBeenCalledWith('org_1/logo.png');
    expect(drawn().seller.logo).toEqual({ data: PNG, format: 'png' });
  });

  it('cannot swap the uploaded signature: only its upload route sets it', async () => {
    await post({
      sample: 'credit_note',
      settings: { signature: { storageKey: 'org_2/theirs.png', url: 'x' } },
    });
    expect(drawn().signatory?.image).toBeNull();
  });

  it('is for the managers who can change the settings', () => {
    const handler = Object.getOwnPropertyDescriptor(
      InvoiceDesignController.prototype,
      'preview',
    )?.value as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.MANAGER,
    ]);
  });
});
