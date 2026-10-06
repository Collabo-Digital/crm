import { formatRelativeTime } from "~/lib/format-date";
import type { OrderShopifySync } from "~/types/api";

/**
 * Mirror of `STALE_PENDING_SYNC_MS` / `isStalePendingSync` on the server
 * (`server/src/channel/shopify-push.service.ts`). Keep the two in step: the
 * Sync action must reappear at the same moment the server would accept a
 * re-claim, or the merchant sees a button that returns "already in progress".
 */
export const STALE_PENDING_SYNC_MS = 15 * 60 * 1000;

/**
 * The part of a push claim the staleness rule reads. Orders and products
 * share the rule, so this is deliberately not tied to either sync type.
 */
type PushClaim = { status?: string; queuedAt?: string } | null | undefined;

export function isStalePendingSync(
  sync: PushClaim,
  now: number = Date.now(),
): boolean {
  if (sync?.status !== "PENDING") return false;
  if (!sync.queuedAt) return true;
  const at = Date.parse(sync.queuedAt);
  return !Number.isFinite(at) || now - at > STALE_PENDING_SYNC_MS;
}

/**
 * Whether a MANUAL order can be (re)pushed to Shopify from the UI: never
 * pushed, the last push failed, or a PENDING claim that has clearly been
 * abandoned (queue was down, job evicted) and would otherwise dead-end the
 * order with no visible way out.
 */
export function canRetryShopifySync(
  sync: PushClaim,
  now: number = Date.now(),
): boolean {
  return !sync || sync.status === "FAILED" || isStalePendingSync(sync, now);
}

/**
 * The shape both the products and the orders tables render in their Shopify
 * column: a pill, one line under it, and which button (if any) the row gets.
 * `A` is the page's own action vocabulary; each page declares its own.
 */
export type ShopifySyncState =
  | "synced"
  | "out_of_sync"
  | "syncing"
  | "failed"
  | "stuck"
  | "not_on_shopify"
  /** On a Shopify channel but with no sync record: nothing is known either way. */
  | "unstamped";

export interface ShopifySyncSummary<A extends string> {
  state: ShopifySyncState;
  /** The pill text. */
  label: string;
  /** The one line under the pill: when, why, or what went wrong. */
  reason: string;
  /** Null when there is nothing to do from this row. */
  action: A | null;
}

export type OrderSyncAction = "sync" | "retry";

/** The part of the order's push record the pages read. */
export type OrderShopifySyncRecord = Pick<
  OrderShopifySync,
  "status" | "shopifyOrderId" | "shopifyOrderName" | "error" | "syncedAt" | "queuedAt"
>;

type OrderSyncSource = {
  channel?: { platform: string; name?: string } | null;
  /** The list endpoint's projection of the record. */
  shopifySync?: OrderShopifySyncRecord | null;
  /** The detail endpoint's whole blob, which holds the same record. */
  metadata?: unknown;
};

/**
 * The order's push record from whichever shape the caller holds: the list's
 * `shopifySync` projection, else the detail's `metadata.shopifySync`.
 */
export function orderShopifySyncOf(order: OrderSyncSource): OrderShopifySyncRecord | undefined {
  if (order.shopifySync !== undefined) return order.shopifySync ?? undefined;
  return (order.metadata as { shopifySync?: OrderShopifySyncRecord } | null | undefined)
    ?.shopifySync;
}

/**
 * One description of an order's Shopify state for the orders table. Only a
 * MANUAL (Collabo-created) order can be pushed; an order that arrived from
 * Shopify is Shopify's own and has nothing to sync. The action agrees with
 * `canRetryShopifySync` by construction, so the pill and the button cannot
 * disagree.
 */
export function describeOrderShopifySync(
  order: OrderSyncSource,
  now: number = Date.now(),
): ShopifySyncSummary<OrderSyncAction> {
  const platform = order.channel?.platform;
  if (platform === "SHOPIFY") {
    return { state: "synced", label: "Synced", reason: "Placed on Shopify", action: null };
  }
  if (platform !== "MANUAL") {
    // Only an explicit MANUAL channel reaches the push branches below. A row
    // handed in without its channel (the dashboard's compact rows carry
    // none) must not be guessed to be a Collabo order and offered a Sync.
    return platform
      ? {
          state: "not_on_shopify",
          label: "Not on Shopify",
          reason: `Placed on ${order.channel?.name ?? platform}`,
          action: null,
        }
      : { state: "unstamped", label: "Unknown", reason: "Channel not loaded", action: null };
  }

  const sync = orderShopifySyncOf(order);
  if (sync?.status === "PENDING" && !isStalePendingSync(sync, now)) {
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
  if (isStalePendingSync(sync, now)) {
    const queued = formatRelativeTime(sync?.queuedAt, now);
    return {
      state: "stuck",
      label: "Sync stuck",
      reason: queued ? `Queued ${queued}` : "Queued, never picked up",
      action: "retry",
    };
  }
  if (sync?.status === "SYNCED") {
    const syncedAgo = formatRelativeTime(sync.syncedAt, now);
    const asName = sync.shopifyOrderName ? ` as ${sync.shopifyOrderName}` : "";
    return {
      state: "synced",
      label: "Synced",
      reason: syncedAgo ? `Synced ${syncedAgo}${asName}` : `Synced to Shopify${asName}`,
      action: null,
    };
  }
  if (!sync) {
    return {
      state: "not_on_shopify",
      label: "Not on Shopify",
      reason: "Created in Collabo",
      action: "sync",
    };
  }
  // A record in a state this build does not know. `canRetryShopifySync`
  // says no for it, so no button here either — the two must agree.
  return {
    state: "unstamped",
    label: "Unknown",
    reason: `Sync status ${String(sync.status)}`,
    action: null,
  };
}

/** Label for the row / detail action given the current sync state. */
export function shopifySyncActionLabel(
  sync: PushClaim,
  now: number = Date.now(),
): string {
  if (sync?.status === "FAILED") return "Retry sync to Shopify";
  if (isStalePendingSync(sync, now)) return "Sync stuck — retry";
  return "Sync to Shopify";
}
