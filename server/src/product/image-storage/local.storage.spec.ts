import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalImageStorage } from './local.storage';

/** PDFs read uploaded logos and signatures back through `read`. */
describe('LocalImageStorage.read', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  let dir: string;
  let storage: LocalImageStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'collabo-uploads-'));
    // The store roots itself at <cwd>/uploads/products when it is built.
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    storage = new LocalImageStorage();
    jest.spyOn(storage['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('reads back the bytes an upload stored, by its storage key', async () => {
    const stored = await storage.upload({
      orgId: 'org_1',
      buffer: PNG,
      originalName: 'logo.png',
      mimeType: 'image/png',
      size: PNG.length,
    });

    expect(stored.storageKey).toMatch(/^org_1\/[0-9a-f-]+\.png$/);
    await expect(storage.read(stored.storageKey)).resolves.toEqual(PNG);
  });

  it('never reads outside the uploads folder', async () => {
    await expect(storage.read('../../../etc/passwd')).rejects.toThrow('Image not found');
    await expect(storage.read('org_1/../../secret.png')).rejects.toThrow('Image not found');
  });

  it('fails for a file that is not there, so a caller can fall back', async () => {
    await expect(storage.read('org_1/missing.png')).rejects.toThrow(/ENOENT/);
  });
});

/**
 * Product images are deleted by a key rebuilt from the image's URL, and a CSV
 * import can set that URL to anything: no key may unlink a file outside the
 * uploads folder.
 */
describe('LocalImageStorage.delete', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let dir: string;
  let storage: LocalImageStorage;
  const exists = (path: string) => access(path).then(() => true, () => false);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'collabo-uploads-'));
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    storage = new LocalImageStorage();
    jest.spyOn(storage['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(storage['logger'], 'warn').mockImplementation(() => undefined);
    // <dir>/outside.txt and <dir>/elsewhere/secret.txt sit beside the uploads folder.
    await writeFile(join(dir, 'outside.txt'), 'keep');
    await mkdir(join(dir, 'elsewhere'));
    await writeFile(join(dir, 'elsewhere', 'secret.txt'), 'keep');
    await mkdir(join(dir, 'uploads', 'products', 'org_1'), { recursive: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('deletes a file an upload stored', async () => {
    const stored = await storage.upload({ orgId: 'org_1', buffer: PNG, originalName: 'a.png', mimeType: 'image/png', size: PNG.length });
    const path = join(dir, 'uploads', 'products', stored.storageKey);
    expect(await exists(path)).toBe(true);

    await storage.delete(stored.storageKey);

    expect(await exists(path)).toBe(false);
  });

  it.each([
    ['climbing out', '../../outside.txt'],
    ['climbing out of an org folder', 'org_1/../../../outside.txt'],
    ['an absolute path', '<dir>/outside.txt'],
    ['the uploads folder itself', 'org_1/..'],
  ])('refuses a key %s', async (_what, key) => {
    await storage.delete(key.replace('<dir>', dir));

    expect(await exists(join(dir, 'outside.txt'))).toBe(true);
    expect(await exists(join(dir, 'uploads', 'products'))).toBe(true);
  });

  it('reads an encoded climb as a file name, not a way out', async () => {
    await storage.delete('org_1/..%2f..%2f..%2foutside.txt');
    await storage.delete('org_1/%2e%2e/%2e%2e/%2e%2e/outside.txt');

    expect(await exists(join(dir, 'outside.txt'))).toBe(true);
  });

  it('refuses a key through a link that leads out of the uploads folder', async () => {
    await symlink(join(dir, 'elsewhere'), join(dir, 'uploads', 'products', 'org_1', 'escape'));
    await symlink(join(dir, 'elsewhere'), join(dir, 'uploads', 'products', 'org_linked'));

    await storage.delete('org_1/escape/secret.txt');
    await storage.delete('org_linked/secret.txt');

    expect(await exists(join(dir, 'elsewhere', 'secret.txt'))).toBe(true);
  });

  it('removes only a link itself, never the file it points at', async () => {
    const link = join(dir, 'uploads', 'products', 'org_1', 'link.png');
    await symlink(join(dir, 'outside.txt'), link);

    await storage.delete('org_1/link.png');

    expect(await exists(link)).toBe(false);
    expect(await exists(join(dir, 'outside.txt'))).toBe(true);
  });
});
