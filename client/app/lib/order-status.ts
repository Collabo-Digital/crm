import type { FinancialStatus, FulfillmentStatus } from "~/types/api";
import { STATUS_TONE_CLASSES, toneClasses, type StatusTone } from "./status-tone.ts";

/**
 * Canonical order-status pill styling and labels.
 *
 * These maps used to be copy-pasted into orders-table.tsx and orders/$id.tsx.
 * The detail-page copy drifted: it used raw hex instead of tokens and rendered
 * the bare enum, so the page read "PARTIALLY_PAID" where the table read
 * "Partial". One source now, imported by both.
 *
 * Colours come from the shared palette in status-tone.ts: every done state is
 * success green, every waiting-on-you state is attention amber.
 */

export const FINANCIAL_TONES: Record<FinancialStatus, StatusTone> = {
  PAID: "success",
  PARTIALLY_PAID: "info",
  PENDING: "attention",
  AUTHORIZED: "info",
  PARTIALLY_REFUNDED: "attention",
  REFUNDED: "neutral",
  VOIDED: "critical",
};

export const FULFILLMENT_TONES: Record<FulfillmentStatus, StatusTone> = {
  FULFILLED: "success",
  PARTIAL: "info",
  UNFULFILLED: "attention",
  RESTOCKED: "neutral",
};

export const FINANCIAL_CLASSES = toneClasses(FINANCIAL_TONES);
export const FULFILLMENT_CLASSES = toneClasses(FULFILLMENT_TONES);

/** Short labels — for the list table, where the column is narrow. */
export const FINANCIAL_LABELS: Record<FinancialStatus, string> = {
  PAID: "Paid",
  PARTIALLY_PAID: "Partial",
  PENDING: "Pending",
  AUTHORIZED: "Authorized",
  PARTIALLY_REFUNDED: "Partial Refund",
  REFUNDED: "Refunded",
  VOIDED: "Voided",
};

export const FULFILLMENT_LABELS: Record<FulfillmentStatus, string> = {
  FULFILLED: "Fulfilled",
  PARTIAL: "Partial",
  UNFULFILLED: "Unfulfilled",
  RESTOCKED: "Restocked",
};

/** Full labels — for the detail page, where there is room to be unambiguous. */
export const FINANCIAL_LABELS_FULL: Record<FinancialStatus, string> = {
  ...FINANCIAL_LABELS,
  PARTIALLY_PAID: "Partially paid",
  PARTIALLY_REFUNDED: "Partially refunded",
};

export const FULFILLMENT_LABELS_FULL: Record<FulfillmentStatus, string> = {
  ...FULFILLMENT_LABELS,
  PARTIAL: "Partly fulfilled",
};

/**
 * Per-line fulfilment state. The API returns a lowercase free-form string:
 * null | 'fulfilled' | 'delivered' | 'on_hold' | 'in_progress'.
 */
export const LINE_STATUS_CLASSES: Record<string, string> = toneClasses({
  fulfilled: "success",
  delivered: "success",
  in_progress: "info",
  on_hold: "neutral",
  // Amber, matching the "Partly shipped" group on the order detail page. It was
  // blue, which made it indistinguishable from in_progress — two different
  // things (units already gone out vs. being prepared).
  partial: "attention",
});

export const LINE_STATUS_LABELS: Record<string, string> = {
  fulfilled: "Fulfilled",
  delivered: "Delivered",
  in_progress: "In progress",
  on_hold: "On hold",
  partial: "Partly shipped",
};

/** `null` means the line was never actioned — the API stores no "unfulfilled" value. */
export function lineStatusLabel(status: string | null): string {
  if (!status) return "Unfulfilled";
  return LINE_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

export function lineStatusClass(status: string | null): string {
  if (!status) return STATUS_TONE_CLASSES.attention;
  return LINE_STATUS_CLASSES[status] ?? STATUS_TONE_CLASSES.neutral;
}

/** A line counts as done when it is fulfilled or already delivered — matches the server predicate. */
export function isLineFulfilled(status: string | null): boolean {
  return status === "fulfilled" || status === "delivered";
}

/* ── Per-line action predicates ──────────────────────────────────────────────
 *
 * What the SERVER actually allows, so the owner grouped layout and the vendor
 * flat layout ask one question instead of each testing the group label.
 *
 * None of the endpoints behind these look at `Order.fulfillmentStatus`,
 * `cancelledAt` or `closedAt` — the only real preconditions are:
 *   - unfulfil is refused on a line already `delivered`
 *     (order.service.ts: "Delivered items cannot be changed.")
 *   - tracking needs a fulfilment row to attach to, which is a row-EXISTENCE
 *     test, not a status test ("Fulfil this item before adding tracking.")
 * Gating on anything else only hides an action the user is allowed to take,
 * which is exactly how Unfulfil / Mark delivered / Add tracking went missing
 * on every fully-fulfilled order.
 */

/** The minimum a line has to expose for the predicates below. */
export type LineFulfilmentShape = {
  quantity: number;
  fulfillmentStatus: string | null;
  fulfilledQuantity?: number | null;
};

/**
 * Units actually shipped on this line.
 *
 * The status fallback is load-bearing. The Shopify sync writes
 * `fulfillmentStatus` but NEVER `fulfilledQuantity`, so a line fulfilled in
 * Shopify reads `{ fulfillmentStatus: 'fulfilled', fulfilledQuantity: 0 }`.
 * Trusting the count alone reports it as entirely unshipped, which would take
 * Unfulfil / Mark delivered / Add tracking away on exactly the orders this fix
 * is meant to repair. Mirrors the server's own fallback in
 * `computeFulfillmentStatus`.
 */
export function shippedUnits(li: LineFulfilmentShape): number {
  const shipped = li.fulfilledQuantity ?? 0;
  if (shipped > 0) return Math.min(shipped, li.quantity);
  return isLineFulfilled(li.fulfillmentStatus) ? li.quantity : 0;
}

/** Units on a line still owed to the customer. */
export function remainingUnits(li: LineFulfilmentShape): number {
  return Math.max(li.quantity - shippedUnits(li), 0);
}

export function hasOutstandingUnits(lines: LineFulfilmentShape[]): boolean {
  return lines.some((li) => remainingUnits(li) > 0);
}

/**
 * Whether a fulfilment row exists for this line — which is the real condition
 * the tracking endpoint tests.
 *
 * Broader than `shippedUnits > 0` on purpose: a line can read `partial` with no
 * count, because Shopify reports a part-shipped line's status without telling
 * us how many units went. Something shipped, so the line has a shipment and is
 * both trackable and reversible — it just is not a candidate for delivery.
 */
export function lineHasShipment(li: LineFulfilmentShape): boolean {
  return shippedUnits(li) > 0 || li.fulfillmentStatus === "partial";
}

/**
 * Unfulfil cancels the shipment and zeroes the count, so it is legal on a
 * partly-shipped line too. Delivered is the one state the server refuses to
 * move backwards ("Delivered items cannot be changed.").
 */
export function canUnfulfilLine(li: LineFulfilmentShape): boolean {
  return lineHasShipment(li) && li.fulfillmentStatus !== "delivered";
}

/**
 * Fully-shipped lines only, even though the server would accept any line.
 *
 * `markVendorItemDelivered` writes `delivered` without touching
 * `fulfilledQuantity`, and unfulfil then refuses the line for ever — so
 * delivering a half-shipped line strands its remaining units with no way to
 * ship or revert them through the UI. Requiring nothing outstanding is what
 * keeps that dead end unreachable.
 */
export function canMarkLineDelivered(li: LineFulfilmentShape): boolean {
  return shippedUnits(li) > 0 && remainingUnits(li) === 0 && li.fulfillmentStatus !== "delivered";
}

/**
 * Tracking only needs a fulfilment row to attach to — the server's check is
 * row existence, not line status. So partly-shipped lines qualify, and a
 * delivered parcel stays re-trackable, which is a legitimate correction.
 */
export function canEditLineTracking(li: LineFulfilmentShape): boolean {
  return lineHasShipment(li);
}

/* ── Shipment (OrderFulfillment) status ──────────────────────────────────── */

/**
 * `OrderFulfillment.status` is free-form and carries TWO vocabularies. The CRM
 * writes `fulfilled` / `delivered` / `cancelled`; the Shopify sync writes
 * Shopify's own enum lowercased, where a completed shipment is `success`.
 * Every client check written against `"fulfilled"` therefore missed every
 * synced shipment, and the status chip printed the raw word.
 */
export type ShipmentStateKey = "pending" | "fulfilled" | "delivered" | "cancelled" | "failed";

const SHIPMENT_STATE: Record<string, ShipmentStateKey> = {
  // CRM vocabulary
  pending: "pending",
  fulfilled: "fulfilled",
  delivered: "delivered",
  cancelled: "cancelled",
  // Shopify's enum, lowercased by the sync
  success: "fulfilled",
  open: "pending",
  in_progress: "pending",
  canceled: "cancelled",
  error: "failed",
  failure: "failed",
};

export function normalizeFulfillmentStatus(status: string | null | undefined): ShipmentStateKey {
  if (!status) return "pending";
  return SHIPMENT_STATE[status.toLowerCase()] ?? "pending";
}

const SHIPMENT_LABELS: Record<ShipmentStateKey, string> = {
  pending: "Pending",
  fulfilled: "Fulfilled",
  delivered: "Delivered",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function fulfillmentStatusLabel(status: string | null | undefined): string {
  return SHIPMENT_LABELS[normalizeFulfillmentStatus(status)];
}

/** A failed Shopify fulfilment must not wear the success colour. */
export const SHIPMENT_STATE_CLASSES = toneClasses<ShipmentStateKey>({
  pending: "attention",
  fulfilled: "success",
  delivered: "success",
  cancelled: "neutral",
  failed: "critical",
});

/** The minimum a shipment has to expose for the predicates below. */
export type ShipmentState = { status: string; deliveredAt?: string | null };

/**
 * `deliveredAt` is checked as well as the status word on purpose: a Shopify
 * shipment the CRM marked delivered has its status overwritten back to
 * `success` by the next pull, while `deliveredAt` survives. Reading the status
 * alone made the "Mark delivered" button reappear on an already-delivered
 * shipment.
 */
export function isShipmentDelivered(f: ShipmentState): boolean {
  return !!f.deliveredAt || normalizeFulfillmentStatus(f.status) === "delivered";
}

export function isShipmentCancelled(f: ShipmentState): boolean {
  return normalizeFulfillmentStatus(f.status) === "cancelled";
}

/** Has left the warehouse: shipped, or already delivered. */
export function isShipmentShipped(f: ShipmentState & { shippedAt?: string | null }): boolean {
  if (f.shippedAt) return true;
  const key = normalizeFulfillmentStatus(f.status);
  return key === "fulfilled" || key === "delivered" || isShipmentDelivered(f);
}

/**
 * Suggested shipping carriers, shared by every tracking input on the order
 * detail page.
 *
 * These are *suggestions*, not a closed set — each input is free text backed by
 * a `<datalist>`. Shopify's `fulfillmentTrackingInfoUpdate` accepts an arbitrary
 * carrier string, so restricting the UI to a dropdown only prevents recording a
 * shipment we can otherwise represent perfectly well. The per-line and bulk
 * inputs used to be a hardcoded one-entry `<select>` (`["Shiprocket"]`) while
 * the shipment dialog was free text hinting "UPS, USPS, FedEx, BlueDart" — two
 * vocabularies for one field. This is the one list; keep all three inputs on it.
 */
export const CARRIER_SUGGESTIONS = [
  "Shiprocket",
  "Delhivery",
  "Blue Dart",
  "DTDC",
  "Ecom Express",
  "India Post",
  "XpressBees",
  "FedEx",
  "DHL",
  "UPS",
] as const;
