import { createHash } from 'crypto';

export const SHOPIFY_PUSH_QUEUE = 'shopify-push';

/**
 * Fields every push job carries for the outbound rate limiter and BullMQ
 * ordering. `priority` uses the Priority enum values (1 interactive,
 * 5 normal, 10 bulk) and MUST be set on every add: BullMQ treats an unset
 * priority as 0, the highest, so a forgotten field would let a background job
 * jump ahead of a user's click.
 */
interface PushJobBase {
  priority?: number;
  /// Links the per-item jobs a planner fanned out back to that planner run.
  bulkRunId?: string;
}

/**
 * Discriminated union of every kind of push job. The processor switches on
 * `type` and dispatches to the right service method.
 */
export type ShopifyPushJobData =
  | (PushJobBase & {
      type: 'order';
      orderId: string;
      organizationId: string;
    })
  | (PushJobBase & {
      type: 'product';
      productId: string;
      organizationId: string;
    })
  | (PushJobBase & {
      /**
       * PLANNER: lists the products that need pushing and fans them out as one
       * `product` job each at bulk priority. Used to be a loop inside the
       * worker, which held the only push slot for the whole catalogue and
       * starved every other tenant's single-item pushes.
       */
      type: 'bulk-products';
      organizationId: string;
    })
  | (PushJobBase & {
      /** PLANNER for unsynced offline orders — see `bulk-products`. */
      type: 'bulk-orders';
      organizationId: string;
    })
  | (PushJobBase & {
      /**
       * Absolute `available` push for specific variants after a CRM-origin
       * stock operation (adjustment, enable-seed, receipt, return restock).
       * Enqueued by InventoryModule directly on this queue — deliberately NOT
       * via ShopifyPushEnqueuer, to keep InventoryModule free of a
       * ChannelModule import (ChannelModule imports InventoryModule for the
       * ledger; the queue name is the cycle-free seam between them).
       */
      type: 'push-availability';
      organizationId: string;
      variantIds: string[];
    })
  | (PushJobBase & {
      /**
       * Mirror the store's Shopify locations as warehouses, then reconcile
       * per-location stock into them. Enqueued by InventoryModule at the end
       * of the warehousing enable flow, for the same reason as
       * `push-availability` above: the queue name is the cycle-free seam, so
       * the inventory side can reach ChannelModule without importing it.
       *
       * Named for its effect, not its direction — this one pulls. It rides
       * this queue because the seam is what matters, not the verb.
       */
      type: 'sync-locations';
      organizationId: string;
    });

/**
 * Stable job ids so a repeat enqueue while the previous job is still live is a
 * no-op. Hyphens only: BullMQ reserves ":" and rejects ids containing it.
 */
export const pushJobId = {
  order: (orderId: string) => `push-order-${orderId}`,
  product: (productId: string) => `push-product-${productId}`,
  availability: (orgId: string, variantIds: string[]) =>
    `push-availability-${orgId}-${createHash('sha1')
      .update([...new Set(variantIds)].sort().join(','))
      .digest('hex')
      .slice(0, 12)}`,
  locations: (orgId: string) => `sync-locations-${orgId}`,
};

/**
 * Default retry policy for every push job. Rate-limit parking does not consume
 * an attempt (see parkIfRateLimited); these are for real failures.
 */
export const PUSH_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 days
  removeOnFail: { age: 60 * 60 * 24 * 30 }, // 30 days for inspection
};
