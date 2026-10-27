import { mkdtemp, rm } from 'fs/promises';
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
