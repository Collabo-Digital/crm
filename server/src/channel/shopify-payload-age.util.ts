/**
 * How recent a Shopify fact must be before a live webhook may treat it as
 * news — that is, raise store events (order messages, COD confirmation,
 * review requests) and auto-invoice.
 *
 * A live webhook can carry an order the CRM has never stored: one older than
 * the 60-day backfill, or one the backfill has not reached yet. Any app or
 * merchant edit to it sends `orders/updated`, and without these windows that
 * first sighting read as a brand-new order — "order confirmed" messages and a
 * GST invoice dated today for a sale months old.
 */
export const FIRST_SIGHTING_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A fulfilment first reported delivered only raises `delivered` while the
 * shipment itself is this recent. Deliveries Shopify reported before the CRM
 * stored `deliveredAt` therefore cannot all fire at once the next time an old
 * order is edited (a bulk tag of 500 orders is 500 review requests).
 */
export const DELIVERED_EVENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A refund raises its store event (one message per refund) only while it is
 * this recent, so a catch-up or an edit to an old order never announces old
 * refunds.
 */
export const REFUND_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a Shopify refund is news: money moved, recently. Cancelling an
 * unpaid order records a restock-only refund with no transaction, whose
 * amount is zero.
 */
export function isRefundNews(refund: { processed_at?: unknown; created_at?: unknown }, amount: { toString(): string }, now: number = Date.now()): boolean {
  return Number(amount.toString()) > 0 && isWithinWindow(refund.processed_at ?? refund.created_at, REFUND_EVENT_WINDOW_MS, now);
}

/**
 * True when a Shopify payload's `updated_at` is strictly older than what the
 * stored row was last written from. Shopify does not order webhooks, so a
 * retried or late delivery must not overwrite newer data. Equal is not older:
 * a redelivery re-applies harmlessly. No stored time or no usable incoming
 * time is never older.
 */
export function isOlderShopifyPayload(updatedAt: unknown, stored: Date | null): boolean {
  if (!stored) return false;
  const incoming =
    updatedAt instanceof Date
      ? updatedAt.getTime()
      : typeof updatedAt === 'string' && updatedAt !== ''
        ? Date.parse(updatedAt)
        : NaN;
  return Number.isFinite(incoming) && incoming < stored.getTime();
}

/** True when `iso` is a parseable time no older than `windowMs`. */
export function isWithinWindow(iso: unknown, windowMs: number, now: number = Date.now()): boolean {
  if (typeof iso !== 'string' || iso === '') return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && now - at <= windowMs;
}
