import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalImageStorage } from './image-storage/local.storage';
import { ProductService } from './product.service';

/**
 * Removing a product image deletes its file only when the image is one of the
 * organization's own uploads. An image's src can come from a CSV import and
 * name any path: outside the uploads folder, or another store's image.
 */
describe('ProductService.removeImage', () => {
  let dir: string;
  const exists = (path: string) => access(path).then(() => true, () => false);
  const uploads = (...parts: string[]) => join(dir, 'uploads', 'products', ...parts);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'collabo-remove-image-'));
    // The store roots itself at <cwd>/uploads/products when it is built.
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    await writeFile(join(dir, 'outside.txt'), 'keep');
    await mkdir(uploads('org_a'), { recursive: true });
    await mkdir(uploads('org_victim'), { recursive: true });
    await writeFile(uploads('org_a', 'own.png'), 'mine');
    await writeFile(uploads('org_victim', 'v.png'), 'theirs');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function build(src: string) {
    const prisma = {
      productImage: {
        findFirst: jest.fn(() => Promise.resolve({ id: 'img1', productId: 'p1', src, product: { channel: { platform: 'MANUAL' } } })),
        delete: jest.fn(() => Promise.resolve({ id: 'img1' })),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ product: { findUnique: () => Promise.resolve(null) } })),
    };
    const storage = new LocalImageStorage();
    jest.spyOn(storage['logger'], 'warn').mockImplementation(() => undefined);
    const service = new ProductService(
      prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, storage as never, {} as never,
    );
    return { service, prisma };
  }

  it('deletes the file of an image the organization uploaded', async () => {
    const { service, prisma } = build('http://localhost:3000/uploads/products/org_a/own.png');

    await expect(service.removeImage('img1', 'org_a')).resolves.toEqual({ id: 'img1', deleted: true });

    expect(await exists(uploads('org_a', 'own.png'))).toBe(false);
    expect(prisma.productImage.delete).toHaveBeenCalledWith({ where: { id: 'img1' } });
  });

  it.each([
    ['climbs out of the uploads folder', 'http://x/uploads/products/../../outside.txt'],
    ['climbs out through its own folder', 'http://x/uploads/products/org_a/../../../outside.txt'],
    ['names another store’s image', 'http://x/uploads/products/org_victim/v.png'],
    ['reaches another store’s image through its own folder', 'http://x/uploads/products/org_a/../org_victim/v.png'],
    ['is a bare path to another store’s image', '/uploads/products/org_victim/v.png'],
  ])('deletes no file for a src that %s, but still removes the image', async (_what, src) => {
    const { service, prisma } = build(src);

    await service.removeImage('img1', 'org_a');

    expect(await exists(join(dir, 'outside.txt'))).toBe(true);
    expect(await exists(uploads('org_victim', 'v.png'))).toBe(true);
    expect(await exists(uploads('org_a', 'own.png'))).toBe(true);
    expect(prisma.productImage.delete).toHaveBeenCalledWith({ where: { id: 'img1' } });
  });

  it('leaves an image hosted elsewhere alone', async () => {
    const { service, prisma } = build('https://cdn.shopify.com/s/files/1/0001/products/kurta.jpg?v=1');

    await service.removeImage('img1', 'org_a');

    expect(await exists(uploads('org_a', 'own.png'))).toBe(true);
    expect(prisma.productImage.delete).toHaveBeenCalled();
  });
});
