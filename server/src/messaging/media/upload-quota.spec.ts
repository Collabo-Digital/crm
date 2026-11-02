import { ExecutionContext, HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import RedisMock from 'ioredis-mock';
import { TemplatesController } from '../../campaigns/templates/templates.controller';
import { InboxController } from '../../inbox/inbox.controller';
import { InboxService } from '../../inbox/inbox.service';
import { RedisService } from '../../redis/redis.service';
import { DAILY_UPLOAD_BYTES, UploadQuotaGuard, UploadQuotaService } from './upload-quota';

const MB = 1024 * 1024;

/** RedisService over ioredis-mock, which runs the real commands. */
function redis() {
  const service = new RedisService({ get: () => 'redis://localhost:6379' } as never);
  const client = new RedisMock();
  (service as unknown as { client: unknown }).client = client;
  return { service, client };
}

const status = (err: unknown) => (err instanceof HttpException ? err.getStatus() : err);

describe('Upload quota — bytes a workspace uploads in a day', () => {
  let r: ReturnType<typeof redis>;
  beforeEach(async () => {
    r = redis();
    await r.client.flushall();
  });

  it('counts uploads up to the limit, refuses the one that would pass it, and does not count it', async () => {
    expect(await r.service.addUploadedBytes('org_a', 60 * MB, 100 * MB)).toBe(true);
    expect(await r.service.addUploadedBytes('org_a', 50 * MB, 100 * MB)).toBe(false);
    expect(await r.service.addUploadedBytes('org_a', 40 * MB, 100 * MB)).toBe(true);
    expect(await r.service.uploadedBytesToday('org_a')).toBe(100 * MB);
    // Another workspace has its own day.
    expect(await r.service.addUploadedBytes('org_b', 100 * MB, 100 * MB)).toBe(true);
  });

  it('lets a burst of parallel uploads through only up to the limit', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => r.service.addUploadedBytes('org_a', 10 * MB, 100 * MB)));

    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await r.service.uploadedBytesToday('org_a')).toBe(100 * MB);
  });

  it('forgets the day after it has passed', async () => {
    await r.service.addUploadedBytes('org_a', MB, 100 * MB);
    const [key] = await r.client.keys('*upload_bytes*');

    expect(key).toContain(`org_a:${new Date().toISOString().slice(0, 10)}`);
    expect(await r.client.ttl(key)).toBeGreaterThan(86400);
  });

  it('refuses with a 429 and a plain message once the day is used up', async () => {
    const quota = new UploadQuotaService(r.service);
    await quota.reserve('org_a', DAILY_UPLOAD_BYTES - MB);

    await expect(quota.assertRoom('org_a')).resolves.toBeUndefined();
    const err: unknown = await quota.reserve('org_a', 2 * MB).catch((e: unknown) => e);
    expect(status(err)).toBe(429);
    expect((err as Error).message).toMatch(/uploaded 5 GB of files today, the daily limit/);

    await quota.reserve('org_a', MB);
    await expect(quota.assertRoom('org_a')).rejects.toBeInstanceOf(HttpException);
  });

  it('turns a full workspace away in the guard, before the file is read', async () => {
    const quota = new UploadQuotaService(r.service);
    const guard = new UploadQuotaGuard(quota);
    const context = (orgId: string) => ({ switchToHttp: () => ({ getRequest: () => ({ user: { orgId } }) }) }) as unknown as ExecutionContext;
    await quota.reserve('org_full', DAILY_UPLOAD_BYTES);

    await expect(guard.canActivate(context('org_ok'))).resolves.toBe(true);
    await expect(guard.canActivate(context('org_full'))).rejects.toBeInstanceOf(HttpException);
  });
});

describe('Upload routes', () => {
  it.each([
    ['POST /inbox/uploads', InboxController.prototype.upload],
    ['POST /campaigns/uploads', TemplatesController.prototype.upload],
  ])('%s is limited per member a minute and checks the daily quota first', (_route, handler) => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UploadQuotaGuard);
  });

  it('counts a chat attachment before storing it, and stores nothing when the quota refuses', async () => {
    const storage = { save: jest.fn(() => Promise.resolve({ storageKey: 'org_a/f.pdf', size: 3 })) };
    const uploadQuota = { reserve: jest.fn(() => Promise.resolve()) };
    const none = {} as never;
    const service = new InboxService(none, none, storage as never, none, none, none, none, none, none, none, none, none, { get: () => 'secret' } as never, uploadQuota as never);
    const pdf = { originalname: 'bill.pdf', mimetype: 'application/pdf', size: 3, buffer: Buffer.from('pdf') };

    await service.upload('org_a', pdf);
    expect(uploadQuota.reserve).toHaveBeenCalledWith('org_a', 3);
    expect(storage.save).toHaveBeenCalledTimes(1);

    uploadQuota.reserve.mockRejectedValueOnce(new HttpException('full', 429));
    await expect(service.upload('org_a', pdf)).rejects.toBeInstanceOf(HttpException);
    expect(storage.save).toHaveBeenCalledTimes(1);
  });
});
