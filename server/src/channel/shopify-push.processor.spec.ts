import { DelayedError, type Job } from 'bullmq';
import { ShopifyPushProcessor } from './shopify-push.processor';
import type { ShopifyPushService } from './shopify-push.service';
import type { ShopifyPushEnqueuer } from './shopify-push.enqueuer';
import type { ShopifyLocationSyncService } from './shopify-location-sync.service';
import type { ShopifyPushJobData } from './shopify-push.queue';
import { Priority, RateLimitedError } from '../rate-limit/rate-limit.types';

const SHOP = { platform: 'shopify' as const, kind: 'bucket' as const, id: 'shop-a' };

function build() {
  const pushService = {
    pushOrder: jest.fn<Promise<void>, [string, string, Priority]>().mockResolvedValue(undefined),
    pushProduct: jest.fn<Promise<void>, [string, string, Priority]>().mockResolvedValue(undefined),
    pushAvailability: jest.fn<Promise<void>, [string, string[], Priority]>().mockResolvedValue(undefined),
    planBulkProductPush: jest.fn<Promise<string[]>, [string]>().mockResolvedValue(['p1', 'p2']),
    planBulkOrderPush: jest.fn<Promise<string[]>, [string]>().mockResolvedValue(['o1']),
    recordFailure: jest.fn<Promise<void>, [string, string, string, boolean?]>().mockResolvedValue(undefined),
    recordProductFailure: jest.fn<Promise<void>, [string, string, string]>().mockResolvedValue(undefined),
  };
  const enqueuer = {
    enqueueProductPushMany: jest.fn<Promise<number>, [string, string[], Priority, string?]>().mockResolvedValue(2),
    enqueueOrderPushMany: jest.fn<Promise<number>, [string, string[], Priority, string?]>().mockResolvedValue(1),
  };
  const locationSync = { runForOrganization: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined) };
  const processor = new ShopifyPushProcessor(
    pushService as unknown as ShopifyPushService,
    enqueuer as unknown as ShopifyPushEnqueuer,
    locationSync as unknown as ShopifyLocationSyncService,
  );
  const mkJob = (data: ShopifyPushJobData) => {
    const moveToDelayed = jest.fn<Promise<void>, [number, string]>().mockResolvedValue(undefined);
    const job = {
      id: 'j1',
      name: 'push-order',
      data,
      attemptsMade: 0,
      opts: { attempts: 5 },
      moveToDelayed,
    } as unknown as Job<ShopifyPushJobData>;
    return { job, moveToDelayed };
  };
  return { processor, pushService, enqueuer, mkJob };
}

describe('ShopifyPushProcessor', () => {
  it('passes the job priority down to the push', async () => {
    const { processor, pushService, mkJob } = build();
    const { job } = mkJob({ type: 'order', orderId: 'o1', organizationId: 'org', priority: Priority.INTERACTIVE });
    await processor.process(job, 'tok');
    expect(pushService.pushOrder).toHaveBeenCalledWith('o1', 'org', Priority.INTERACTIVE);
  });

  it('parks a rate-limited job: moved to delayed, DelayedError thrown, no failure stamped', async () => {
    const { processor, pushService, mkJob } = build();
    const retryAt = Date.now() + 90_000;
    pushService.pushOrder.mockRejectedValueOnce(new RateLimitedError(SHOP, retryAt, 'BUCKET'));
    const { job, moveToDelayed } = mkJob({ type: 'order', orderId: 'o1', organizationId: 'org' });

    await expect(processor.process(job, 'tok')).rejects.toBeInstanceOf(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [at, token] = moveToDelayed.mock.calls[0];
    expect(at).toBeGreaterThanOrEqual(retryAt);
    expect(at).toBeLessThan(retryAt + 3000);
    expect(token).toBe('tok');
    expect(pushService.recordFailure).not.toHaveBeenCalled();
  });

  it('a real failure is stamped on the entity and rethrown for BullMQ', async () => {
    const { processor, pushService, mkJob } = build();
    pushService.pushProduct.mockRejectedValueOnce(new Error('userErrors: title taken'));
    const { job, moveToDelayed } = mkJob({ type: 'product', productId: 'p1', organizationId: 'org' });
    await expect(processor.process(job, 'tok')).rejects.toThrow('title taken');
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(pushService.recordProductFailure).toHaveBeenCalledWith('p1', 'org', 'userErrors: title taken');
  });

  it('bulk planners fan out per-item jobs at bulk priority and finish immediately', async () => {
    const { processor, pushService, enqueuer, mkJob } = build();
    await processor.process(mkJob({ type: 'bulk-products', organizationId: 'org' }).job, 'tok');
    expect(pushService.planBulkProductPush).toHaveBeenCalledWith('org');
    expect(enqueuer.enqueueProductPushMany).toHaveBeenCalledWith('org', ['p1', 'p2'], Priority.BULK, 'j1');
    expect(pushService.pushProduct).not.toHaveBeenCalled();

    await processor.process(mkJob({ type: 'bulk-orders', organizationId: 'org' }).job, 'tok');
    expect(enqueuer.enqueueOrderPushMany).toHaveBeenCalledWith('org', ['o1'], Priority.BULK, 'j1');
  });

  it('without a worker token a rate limit is rethrown untouched, never stamped as a failure', async () => {
    const { processor, pushService, mkJob } = build();
    const err = new RateLimitedError(SHOP, Date.now() + 1000, 'BREAKER');
    pushService.pushOrder.mockRejectedValueOnce(err);
    await expect(processor.process(mkJob({ type: 'order', orderId: 'o1', organizationId: 'org' }).job)).rejects.toBe(err);
    expect(pushService.recordFailure).not.toHaveBeenCalled();
  });
});
