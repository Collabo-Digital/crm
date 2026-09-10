import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Priority } from '../rate-limit/rate-limit.types';
import {
  PUSH_JOB_OPTS,
  SHOPIFY_PUSH_QUEUE,
  ShopifyPushJobData,
  pushJobId,
} from './shopify-push.queue';

/**
 * Thin wrapper that owns the BullMQ Queue handle. Other modules (order,
 * product, channel) inject this rather than the Queue directly so we don't
 * have to repeat `BullModule.registerQueue({ name })` everywhere — and so
 * the call-sites read naturally.
 *
 * Retries (all jobs): 5 attempts with exponential backoff (10s → 20s → 40s
 * → 80s → 160s). Failures land on metadata fields and are inspectable from
 * BullMQ's failed list for 30 days.
 *
 * Every add sets an explicit `priority` (BullMQ: unset = 0 = highest) and a
 * stable `jobId` so a repeat enqueue while the previous job is still live is
 * a no-op rather than a duplicate Shopify mutation.
 */
@Injectable()
export class ShopifyPushEnqueuer {
  private readonly logger = new Logger(ShopifyPushEnqueuer.name);

  constructor(
    @InjectQueue(SHOPIFY_PUSH_QUEUE) private readonly queue: Queue<ShopifyPushJobData>,
  ) {}

  /**
   * Push a single order created in the CRM (e.g. an offline / counter sale).
   *
   * Returns whether a job now exists for the order. Callers stamp the order
   * PENDING around this call, so a swallowed failure used to leave the order
   * "syncing" for ever with nothing in the queue — the caller must be able
   * to record that as FAILED instead.
   */
  async enqueueOrderPush(
    data: Extract<ShopifyPushJobData, { type: 'order' }>,
    priority: Priority = Priority.INTERACTIVE,
  ): Promise<boolean> {
    try {
      return await this.addDeduped('push-order', data, pushJobId.order(data.orderId), priority);
    } catch (err) {
      this.logger.error(`Failed to enqueue Shopify order push for ${data.orderId}: ${err}`);
      return false;
    }
  }

  /**
   * Push current per-warehouse availability for specific variants.
   *
   * A CRM-origin stock change MUST reach Shopify, and not just because the two
   * should agree: `pullLocationInventory` treats Shopify as authoritative, so
   * an un-pushed local change is actively reverted by the next sync.
   */
  async enqueueAvailabilityPush(
    orgId: string,
    variantIds: string[],
    priority: Priority = Priority.NORMAL,
  ): Promise<void> {
    if (variantIds.length === 0) return;
    const ids = [...new Set(variantIds)];
    try {
      await this.addDeduped(
        'push-availability',
        { type: 'push-availability', organizationId: orgId, variantIds: ids },
        pushJobId.availability(orgId, ids),
        priority,
      );
    } catch (err) {
      this.logger.error(`Failed to enqueue availability push for org ${orgId}: ${err}`);
    }
  }

  /** Push a single CRM-native product (one-off, e.g. created while Shopify is connected). */
  async enqueueProductPush(
    data: Extract<ShopifyPushJobData, { type: 'product' }>,
    priority: Priority = Priority.NORMAL,
  ): Promise<void> {
    try {
      await this.addDeduped('push-product', data, pushJobId.product(data.productId), priority);
    } catch (err) {
      this.logger.error(`Failed to enqueue Shopify product push for ${data.productId}: ${err}`);
    }
  }

  /**
   * Fan out one `product` job per id at bulk priority. Called by the
   * `bulk-products` planner. One `addBulk` round trip; per-item ids so a
   * second planner run while these are still queued adds nothing.
   */
  async enqueueProductPushMany(
    orgId: string,
    productIds: string[],
    priority: Priority = Priority.BULK,
    bulkRunId?: string,
  ): Promise<number> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return 0;
    await this.queue.addBulk(
      ids.map((productId) => ({
        name: 'push-product',
        data: {
          type: 'product' as const,
          productId,
          organizationId: orgId,
          priority,
          bulkRunId,
        },
        opts: { ...PUSH_JOB_OPTS, jobId: pushJobId.product(productId), priority },
      })),
    );
    return ids.length;
  }

  /** Fan out one `order` job per id at bulk priority — see `enqueueProductPushMany`. */
  async enqueueOrderPushMany(
    orgId: string,
    orderIds: string[],
    priority: Priority = Priority.BULK,
    bulkRunId?: string,
  ): Promise<number> {
    const ids = [...new Set(orderIds)];
    if (ids.length === 0) return 0;
    await this.queue.addBulk(
      ids.map((orderId) => ({
        name: 'push-order',
        data: {
          type: 'order' as const,
          orderId,
          organizationId: orgId,
          priority,
          bulkRunId,
        },
        opts: { ...PUSH_JOB_OPTS, jobId: pushJobId.order(orderId), priority },
      })),
    );
    return ids.length;
  }

  /**
   * Plan a push of every CRM-native (MANUAL channel) product up to the
   * connected Shopify store. Fired by the channels-page Sync action (or via
   * the post-pull step in `ShopifySyncService.runSync`). The planner job
   * itself is cheap; the work happens in the per-item jobs it fans out.
   */
  async enqueueBulkProductPush(
    data: Extract<ShopifyPushJobData, { type: 'bulk-products' }>,
  ): Promise<void> {
    try {
      await this.queue.add(
        'push-products-bulk',
        { ...data, priority: Priority.BULK },
        { ...PUSH_JOB_OPTS, priority: Priority.BULK },
      );
    } catch (err) {
      this.logger.error(
        `Failed to enqueue Shopify bulk product push for org ${data.organizationId}: ${err}`,
      );
    }
  }

  /** Plan a push of every unsynced offline order — see `enqueueBulkProductPush`. */
  async enqueueBulkOrderPush(
    data: Extract<ShopifyPushJobData, { type: 'bulk-orders' }>,
  ): Promise<void> {
    try {
      await this.queue.add(
        'push-orders-bulk',
        { ...data, priority: Priority.BULK },
        { ...PUSH_JOB_OPTS, priority: Priority.BULK },
      );
    } catch (err) {
      this.logger.error(
        `Failed to enqueue Shopify bulk order push for org ${data.organizationId}: ${err}`,
      );
    }
  }

  /**
   * One job id per entity: a re-enqueue while the previous job is still live
   * (waiting / delayed between retries or parked / active) is a no-op, so two
   * Sync presses cannot run `orderCreate` twice. A finished job (completed or
   * failed) is removed first so a retry after the 5 attempts are exhausted is
   * not silently ignored by BullMQ's id de-duplication.
   *
   * Hyphen, not colon, in every id. BullMQ reserves ":" as its Redis key
   * separator and rejects any custom job id containing one ("Custom Ids
   * cannot contain :"), so every offline-order push used to fail at enqueue —
   * before a single Shopify call — and the order was stamped "Sync failed"
   * with no usable reason.
   */
  private async addDeduped(
    name: string,
    data: ShopifyPushJobData,
    jobId: string,
    priority: Priority,
  ): Promise<boolean> {
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      } else {
        this.logger.log(
          `Shopify push ${jobId} already ${state} — not re-enqueued.`,
        );
        return true;
      }
    }
    await this.queue.add(name, { ...data, priority }, { ...PUSH_JOB_OPTS, jobId, priority });
    return true;
  }
}
