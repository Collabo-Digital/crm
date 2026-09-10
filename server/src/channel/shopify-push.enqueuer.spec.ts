import type { Queue } from 'bullmq';
import { ShopifyPushEnqueuer } from './shopify-push.enqueuer';
import type { ShopifyPushJobData } from './shopify-push.queue';
import { Priority } from '../rate-limit/rate-limit.types';

type AddOpts = { jobId?: string; priority?: number; attempts?: number };
type BulkEntry = { name: string; data: ShopifyPushJobData; opts: AddOpts };
type ExistingJob = { getState: () => Promise<string>; remove?: () => Promise<void> };

/**
 * BullMQ reserves ":" as its Redis key separator and rejects any custom job id
 * containing one (`Custom Id cannot contain :` — bullmq/classes/job.js).
 *
 * The order-push id used to be `push-order:${orderId}`, so EVERY offline order
 * threw at enqueue, before a single Shopify call. The push was swallowed as a
 * warning and the order was left stamped "Sync failed" with no usable reason,
 * which is how it went unnoticed. Observed on DEV 2026-09-05.
 */
function build() {
  const queue = {
    getJob: jest.fn<Promise<ExistingJob | null>, [string]>().mockResolvedValue(null),
    add: jest.fn<Promise<{ id: string }>, [string, ShopifyPushJobData, AddOpts]>().mockResolvedValue({ id: 'job_1' }),
    addBulk: jest.fn<Promise<unknown[]>, [BulkEntry[]]>().mockResolvedValue([]),
  };
  return { queue, enqueuer: new ShopifyPushEnqueuer(queue as unknown as Queue<ShopifyPushJobData>) };
}

describe('ShopifyPushEnqueuer — order push job id', () => {
  const data = { type: 'order' as const, orderId: 'order_1', organizationId: 'org_1' };

  it('mints a job id BullMQ will accept', async () => {
    const { queue, enqueuer } = build();

    await expect(enqueuer.enqueueOrderPush(data)).resolves.toBe(true);

    const jobId = queue.add.mock.calls[0][2].jobId;
    expect(jobId).not.toContain(':');
    expect(jobId).toBe('push-order-order_1');
  });

  it('still de-duplicates per order, so two Sync presses enqueue once', async () => {
    const { queue, enqueuer } = build();
    queue.getJob.mockResolvedValue({ getState: () => Promise.resolve('waiting') });

    await expect(enqueuer.enqueueOrderPush(data)).resolves.toBe(true);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reports failure to the caller instead of leaving the order "syncing" for ever', async () => {
    const { queue, enqueuer } = build();
    queue.add.mockRejectedValue(new Error('redis down'));

    await expect(enqueuer.enqueueOrderPush(data)).resolves.toBe(false);
  });
});

/**
 * BullMQ treats an UNSET priority as 0 — the highest — so a producer that
 * forgets the field lets a background job jump ahead of a user's click.
 * Every add this wrapper makes must therefore carry an explicit priority,
 * both in BullMQ's options (ordering) and in the job data (what the push
 * passes to the rate limiter).
 */
describe('ShopifyPushEnqueuer — priority and de-duplication on every add', () => {
  it('order push defaults to INTERACTIVE, in both options and data', async () => {
    const { queue, enqueuer } = build();
    await enqueuer.enqueueOrderPush({ type: 'order', orderId: 'o1', organizationId: 'org' });
    const [, jobData, opts] = queue.add.mock.calls[0];
    expect(opts.priority).toBe(Priority.INTERACTIVE);
    expect(jobData.priority).toBe(Priority.INTERACTIVE);
  });

  it('product push defaults to NORMAL and gets a stable job id', async () => {
    const { queue, enqueuer } = build();
    await enqueuer.enqueueProductPush({ type: 'product', productId: 'p1', organizationId: 'org' });
    const [, jobData, opts] = queue.add.mock.calls[0];
    expect(opts).toMatchObject({ jobId: 'push-product-p1', priority: Priority.NORMAL, attempts: 5 });
    expect(jobData.priority).toBe(Priority.NORMAL);
  });

  it('availability push hashes the variant set into its job id', async () => {
    const { queue, enqueuer } = build();
    await enqueuer.enqueueAvailabilityPush('org', ['v2', 'v1', 'v2']);
    await enqueuer.enqueueAvailabilityPush('org', ['v1', 'v2']);
    const ids = queue.add.mock.calls.map((c) => c[2].jobId);
    expect(ids[0]).toMatch(/^push-availability-org-[0-9a-f]{12}$/);
    expect(ids[0]).toBe(ids[1]);
    const first = queue.add.mock.calls[0][1];
    expect(first.type === 'push-availability' && first.variantIds).toEqual(['v2', 'v1']);
  });

  it('bulk planners are queued at BULK priority', async () => {
    const { queue, enqueuer } = build();
    await enqueuer.enqueueBulkProductPush({ type: 'bulk-products', organizationId: 'org' });
    await enqueuer.enqueueBulkOrderPush({ type: 'bulk-orders', organizationId: 'org' });
    for (const [, jobData, opts] of queue.add.mock.calls) {
      expect(jobData.priority).toBe(Priority.BULK);
      expect(opts.priority).toBe(Priority.BULK);
    }
  });

  it('fan-out uses one addBulk with per-item ids, BULK priority and the run id', async () => {
    const { queue, enqueuer } = build();
    await expect(enqueuer.enqueueProductPushMany('org', ['p1', 'p2', 'p1'], Priority.BULK, 'run9')).resolves.toBe(2);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    const jobs = queue.addBulk.mock.calls[0][0];
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      name: 'push-product',
      data: { type: 'product', productId: 'p1', organizationId: 'org', priority: Priority.BULK, bulkRunId: 'run9' },
      opts: { jobId: 'push-product-p1', priority: Priority.BULK },
    });
    await expect(enqueuer.enqueueProductPushMany('org', [])).resolves.toBe(0);
  });

  it('a finished job with the same id is removed so the retry is not silently ignored', async () => {
    const { queue, enqueuer } = build();
    const remove = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    queue.getJob.mockResolvedValue({ getState: () => Promise.resolve('failed'), remove });
    await enqueuer.enqueueProductPush({ type: 'product', productId: 'p1', organizationId: 'org' });
    expect(remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });
});
