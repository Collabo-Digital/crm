import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SHOPIFY_PUSH_QUEUE, ShopifyPushJobData } from './shopify-push.queue';

const DEFAULT_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 days
  removeOnFail: { age: 60 * 60 * 24 * 30 }, // 30 days for inspection
};

/**
 * Thin wrapper that owns the BullMQ Queue handle. Other modules (order,
 * product, channel) inject this rather than the Queue directly so we don't
 * have to repeat `BullModule.registerQueue({ name })` everywhere — and so
 * the call-sites read naturally.
 *
 * Retries (all jobs): 5 attempts with exponential backoff (10s → 20s → 40s
 * → 80s → 160s). Failures land on metadata fields and are inspectable from
 * BullMQ's failed list for 30 days.
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
   *
   * One job id per order: a re-claim while the previous job is still live
   * (waiting / delayed between retries / active) is a no-op, so two Sync
   * presses cannot run `orderCreate` twice. A finished job (completed or
   * failed) is removed first so a retry after the 5 attempts are exhausted
   * is not silently ignored by BullMQ's id de-duplication.
   */
  async enqueueOrderPush(data: Extract<ShopifyPushJobData, { type: 'order' }>): Promise<boolean> {
    // Hyphen, not colon. BullMQ reserves ":" as its Redis key separator and
    // rejects any custom job id containing one ("Custom Ids cannot contain :"),
    // so every offline-order push failed at enqueue — before a single Shopify
    // call — and the order was stamped "Sync failed" with no usable reason.
    const jobId = `push-order-${data.orderId}`;
    try {
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed') {
          await existing.remove();
        } else {
          this.logger.log(
            `Shopify order push for ${data.orderId} already ${state} (job ${jobId}) — not re-enqueued.`,
          );
          return true;
        }
      }
      await this.queue.add('push-order', data, { ...DEFAULT_JOB_OPTS, jobId });
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to enqueue Shopify order push for ${data.orderId}: ${err}`,
      );
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
  async enqueueAvailabilityPush(orgId: string, variantIds: string[]): Promise<void> {
    if (variantIds.length === 0) return;
    try {
      await this.queue.add(
        'push-availability',
        {
          type: 'push-availability',
          organizationId: orgId,
          variantIds: [...new Set(variantIds)],
        },
        DEFAULT_JOB_OPTS,
      );
    } catch (err) {
      this.logger.error(
        `Failed to enqueue availability push for org ${orgId}: ${err}`,
      );
    }
  }

  /** Push a single CRM-native product (one-off, e.g. created while Shopify is connected). */
  async enqueueProductPush(data: Extract<ShopifyPushJobData, { type: 'product' }>): Promise<void> {
    try {
      await this.queue.add('push-product', data, DEFAULT_JOB_OPTS);
    } catch (err) {
      this.logger.error(
        `Failed to enqueue Shopify product push for ${data.productId}: ${err}`,
      );
    }
  }

  /**
   * Push every CRM-native (MANUAL channel) product up to the connected
   * Shopify store. Fired by the channels-page Sync action (or via the
   * post-pull step in `ShopifySyncService.runSync`). No longer fires
   * automatically on Shopify connect — merchants opt in.
   */
  async enqueueBulkProductPush(
    data: Extract<ShopifyPushJobData, { type: 'bulk-products' }>,
  ): Promise<void> {
    try {
      await this.queue.add('push-products-bulk', data, DEFAULT_JOB_OPTS);
    } catch (err) {
      this.logger.error(
        `Failed to enqueue Shopify bulk product push for org ${data.organizationId}: ${err}`,
      );
    }
  }

  /**
   * Push every unsynced offline (MANUAL channel) order up to the connected
   * Shopify store. Fired by the channels-page Sync action via the post-pull
   * step in `ShopifySyncService.runSync`.
   */
  async enqueueBulkOrderPush(
    data: Extract<ShopifyPushJobData, { type: 'bulk-orders' }>,
  ): Promise<void> {
    try {
      await this.queue.add('push-orders-bulk', data, DEFAULT_JOB_OPTS);
    } catch (err) {
      this.logger.error(
        `Failed to enqueue Shopify bulk order push for org ${data.organizationId}: ${err}`,
      );
    }
  }
}
