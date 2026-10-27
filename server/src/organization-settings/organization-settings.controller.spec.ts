import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { PrismaService } from '../prisma/prisma.service';
import { IMAGE_STORAGE, type UploadInput } from '../product/image-storage/image-storage.interface';
import { OrganizationSettingsController } from './organization-settings.controller';
import { OrganizationSettingsService } from './organization-settings.service';

/**
 * The new routes as the settings page calls them: uploads as multipart
 * through Multer, patches through the Zod pipe. The service is the real one;
 * the guards are left out, and the caller is always org_1.
 */
describe('OrganizationSettingsController invoice routes', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00', 'latin1');

  let app: INestApplication;
  let row: Record<string, unknown>;
  let storage: { upload: jest.Mock; delete: jest.Mock; read: jest.Mock };

  beforeEach(async () => {
    row = {};
    storage = {
      upload: jest.fn((input: UploadInput) =>
        Promise.resolve({
          url: `http://api.test/uploads/products/${input.orgId}/f1.png`,
          storageKey: `${input.orgId}/f1.png`,
          mimeType: input.mimeType,
          size: input.size,
        }),
      ),
      delete: jest.fn(),
      read: jest.fn(),
    };
    const prisma = {
      organizationSettings: {
        findUnique: jest.fn(() => Promise.resolve(row)),
        upsert: jest.fn(({ update }: { update: Record<string, unknown> }) =>
          Promise.resolve(Object.assign(row, update)),
        ),
      },
    };
    const module = await Test.createTestingModule({
      controllers: [OrganizationSettingsController],
      providers: [
        OrganizationSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IMAGE_STORAGE, useValue: storage },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
      req.user = { orgId: 'org_1' };
      next();
    });
    await app.init();
  });

  afterEach(() => app.close());

  const http = () => request(app.getHttpServer());
  /** What the route answered: a settings domain, or Nest's error body. */
  const body = (res: request.Response) => res.body as Record<string, unknown>;

  it('takes a logo as multipart `file` and points the store profile at it', async () => {
    const res = await http()
      .post('/organization/settings/store-profile/logo')
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(body(res)).toEqual(
      expect.objectContaining({
        logoUrl: 'http://api.test/uploads/products/org_1/f1.png',
        logoStorageKey: 'org_1/f1.png',
      }),
    );
  });

  it('refuses a GIF the browser sent as image/png, and a request with no file', async () => {
    const gif = await http()
      .post('/organization/settings/store-profile/logo')
      .attach('file', GIF, { filename: 'logo.png', contentType: 'image/png' });
    expect(gif.status).toBe(400);
    expect(body(gif).message).toBe('The logo must be a PNG or JPEG image.');

    const none = await http().post('/organization/settings/store-profile/logo');
    expect(none.status).toBe(400);
    expect(body(none).message).toBe('Choose an image to upload.');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('removes the logo without deleting the file', async () => {
    await http().post('/organization/settings/store-profile/logo').attach('file', PNG, 'logo.png');

    const res = await http().delete('/organization/settings/store-profile/logo');

    expect(res.status).toBe(200);
    expect(body(res)).toEqual(expect.objectContaining({ logoUrl: '', logoStorageKey: '' }));
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('takes a signature, and removes it again', async () => {
    const added = await http().post('/organization/settings/invoice/signature').attach('file', PNG, 'sign.png');
    expect(added.status).toBe(201);
    expect(body(added).signature).toEqual({
      storageKey: 'org_1/f1.png',
      url: 'http://api.test/uploads/products/org_1/f1.png',
    });

    const removed = await http().delete('/organization/settings/invoice/signature');
    expect(removed.status).toBe(200);
    expect(body(removed).signature).toBeNull();
  });

  it('patches the invoice design, and never takes a signature from the body', async () => {
    const res = await http()
      .patch('/organization/settings/invoice')
      .send({ theme: 'classic', signature: { storageKey: '../../.env', url: 'https://evil.example/x.png' } });

    expect(res.status).toBe(200);
    expect(body(res).theme).toBe('classic');
    expect(body(res).signature).toBeNull();
    expect((row.invoiceSettings as { signature: unknown }).signature).toBeNull();
  });

  it('refuses an invalid design patch with the field named', async () => {
    const res = await http().patch('/organization/settings/invoice').send({ brandColor: 'teal' });

    expect(res.status).toBe(400);
    expect(body(res).errors).toEqual(['brandColor: Enter a colour like #1F6F5C.']);
  });

  it('answers composition and e-invoicing together with a 400 that says why', async () => {
    const res = await http().patch('/organization/settings/tax').send({ composition: true, eInvoicing: true });

    expect(res.status).toBe(400);
    expect(body(res).message).toBe(
      "Composition and e-invoicing can't both be on: the composition scheme ends far below the e-invoicing limit.",
    );
  });
});
