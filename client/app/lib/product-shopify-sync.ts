import { isStalePendingSync, type ShopifySyncSummary } from "~/lib/shopify-sync";
import { formatRelativeTime } from "~/lib/format-date";
import type { ProductShopifySync } from "~/types/api";

/**
 * Shared "can this product be pushed to Shopify?" rules for the products list
 * row and the product page header, so the two sync buttons can't drift apart.
 */

type SyncSource = { channel?: { platform: string } | null };
type PushClaim = Pick<ProductShopifySync, "status" | "queuedAt"> | null | undefined;

/**
 * A push really is under way: PENDING, and claimed recently enough that a job
 * is still working on it. Only this state earns the spinner.
 */
export function isProductPushInFlight(sync: PushClaim): boolean {
  return sync?.status === "PENDING" && !isStalePendingSync(sync);
}

/**
 * PENDING, but nobody is working on it — the queue was down when it was
 * claimed, or the job was lost. It used to render as "Syncing" for ever with
 * no action; it is shown as stuck and can be retried instead.
 */
export function isProductPushStuck(sync: PushClaim): boolean {
  return isStalePendingSync(sync);
}

/**
 * The sync action is hidden only for a Shopify-channel product that is fully
 * SYNCED (nothing to push). Everything else — never pushed, local edits
 * (OUT_OF_SYNC), a failed push, a stuck one, or a MANUAL product — can be
 * synced. An in-flight push is handled by the caller (a spinner, never a
 * second enqueue).
 */
export function canSyncProduct(
  product: SyncSource,
  sync: Pick<ProductShopifySync, "status"> | null | undefined,
): boolean {
  return sync?.status !== "SYNCED" || product.channel?.platform !== "SHOPIFY";
}

/** Tooltip for the sync action, matching the state it will act on. */
export function productSyncActionTitle(sync: PushClaim): string {
  if (sync?.status === "FAILED") return "Retry sync to Shopify";
  if (isProductPushStuck(sync)) return "Sync stuck — retry";
  if (sync?.status === "OUT_OF_SYNC") return "Push local edits to Shopify";
  return "Sync to Shopify";
}

/** What the row's sync button says. Null when there is nothing to push. */
export type ProductSyncAction = "push" | "retry" | "publish" | null;

export type ProductShopifySyncSummary = ShopifySyncSummary<NonNullable<ProductSyncAction>>;

type SyncSummarySource = SyncSource & {
  shopifySync?: Pick<ProductShopifySync, "status" | "queuedAt" | "syncedAt" | "error"> | null;
};

/**
 * One description of a product's Shopify state for the products table: the
 * pill, the line under it, and which button (if any) the row gets. Kept here
 * beside the push rules so the pill can never say "Synced" while the button
 * says "Retry".
 *
 * `OUT_OF_SYNC` cannot name the edited fields — the server stamps the status
 * without recording what changed — so the reason is generic.
 */
export function describeProductShopifySync(
  product: SyncSummarySource,
  now: number = Date.now(),
): ProductShopifySyncSummary {
  const sync = product.shopifySync;
  const onShopifyChannel = product.channel?.platform === "SHOPIFY";

  if (isProductPushInFlight(sync)) {
    return { state: "syncing", label: "Syncing", reason: "Pushing to Shopify…", action: null };
  }
  if (sync?.status === "FAILED") {
    return {
      state: "failed",
      label: "Sync failed",
      reason: sync.error?.trim() || "Unknown error",
      action: "retry",
    };
  }
  if (isProductPushStuck(sync)) {
    const queued = formatRelativeTime(sync?.queuedAt, now);
    return {
      state: "stuck",
      label: "Sync stuck",
      reason: queued ? `Queued ${queued}` : "Queued, never picked up",
      action: "retry",
    };
  }
  if (sync?.status === "OUT_OF_SYNC") {
    return {
      state: "out_of_sync",
      label: "Out of sync",
      reason: "Local edits not pushed",
      action: "push",
    };
  }
  if (sync?.status === "SYNCED") {
    // `syncedAt` is the last time the two copies were confirmed in step —
    // a push's success or a pull's refresh — not only the last push.
    const syncedAgo = formatRelativeTime(sync.syncedAt, now);
    return {
      state: "synced",
      label: "Synced",
      reason: syncedAgo ? `Synced ${syncedAgo}` : "Synced to Shopify",
      // `canSyncProduct` is the one rule for whether anything can be pushed,
      // shared with the product page: a Shopify-channel product has nothing
      // to push; a MANUAL one that was once pushed can be pushed again.
      action: canSyncProduct(product, sync) ? "push" : null,
    };
  }
  // No sync record at all. A Shopify pull now stamps one, so this is a row
  // from before that, or one the backfill has not reached: nothing says
  // whether it has local edits, so the wording claims nothing either way.
  if (onShopifyChannel) {
    return {
      state: "unstamped",
      label: "On Shopify",
      reason: "Not pushed from Collabo yet",
      action: "push",
    };
  }
  return {
    state: "not_on_shopify",
    label: "Not on Shopify",
    reason: "Created in Collabo",
    action: "publish",
  };
}
