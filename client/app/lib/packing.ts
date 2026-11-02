import type {
  FinancialStatus,
  FulfillmentStatus,
  OrderPacking,
  PackConfirmReason,
  PackHoldReason,
  PackingPayment,
  PackingQueueRow,
  PackProblemReason,
  PackScanResponse,
  PackTask,
  PackTaskLine,
} from "~/types/api";

/**
 * The packing screens' wording and rules, kept free of React so they can be
 * tested on their own. The server decides what is allowed; these only decide
 * what to offer and what to say.
 */

export const HOLD_REASONS: ReadonlyArray<{ value: PackHoldReason; label: string }> = [
  { value: "items_short", label: "Items short" },
  { value: "damaged", label: "Item damaged" },
  { value: "customer_request", label: "Customer asked to wait" },
  { value: "other", label: "Something else" },
];

export const PROBLEM_REASONS: ReadonlyArray<{ value: PackProblemReason; label: string }> = [
  { value: "missing", label: "Can't find it" },
  { value: "damaged", label: "Damaged" },
  { value: "wrong_item_on_shelf", label: "Wrong item on the shelf" },
];

export const CONFIRM_REASONS: ReadonlyArray<{ value: PackConfirmReason; label: string }> = [
  { value: "no_barcode", label: "It has no barcode" },
  { value: "barcode_damaged", label: "The barcode won't scan" },
  { value: "other", label: "Another reason" },
];

export function holdReasonLabel(reason: PackHoldReason | null | undefined): string {
  return HOLD_REASONS.find((r) => r.value === reason)?.label ?? "On hold";
}

export function problemReasonLabel(reason: PackProblemReason): string {
  return PROBLEM_REASONS.find((r) => r.value === reason)?.label ?? "Problem";
}

/** "Blue Kurta (M)". Shopify's "Default Title" is not a variant anyone chose. */
export function productName(title: string, variantTitle?: string | null): string {
  return variantTitle && variantTitle !== "Default Title" ? `${title} (${variantTitle})` : title;
}

export function itemsWord(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

export function firstName(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** Units on a line that came from scans, not from a hand confirm or a typed count. */
export function scannedUnits(line: Pick<PackTaskLine, "packed" | "handConfirmed" | "counted">): number {
  return Math.max(0, line.packed - line.handConfirmed - line.counted);
}

/** Typing a count is allowed on lines of 5 or more, once one unit has been scanned. */
export function canEnterCount(line: Pick<PackTaskLine, "required" | "packed" | "handConfirmed" | "counted">): boolean {
  return line.required >= 5 && scannedUnits(line) >= 1;
}

export function taskUnits(lines: ReadonlyArray<Pick<PackTaskLine, "packed" | "required">>): {
  packed: number;
  required: number;
} {
  return lines.reduce(
    (sum, l) => ({ packed: sum.packed + l.packed, required: sum.required + l.required }),
    { packed: 0, required: 0 },
  );
}

// ── Scan feedback ───────────────────────────────────────────────────────────

export type FeedbackTone = "success" | "warning" | "danger";

export interface ScanFeedbackView {
  tone: FeedbackTone;
  title: string;
  detail?: string;
  /** One high beep, or two low ones. */
  sound: "ok" | "error";
  /** Phones that can (not iPhones) buzz for a wrong item. */
  vibrate: boolean;
}

/** What the packer sees and hears for one scan result. */
export function scanFeedback(res: PackScanResponse, code: string): ScanFeedbackView {
  const line = res.lineId ? res.task.lines.find((l) => l.id === res.lineId) : undefined;
  const name = line ? productName(line.title, line.variantTitle) : "This item";

  switch (res.result) {
    case "matched": {
      if (line && line.packed < line.required) {
        return {
          tone: "success",
          title: `${name}: ${line.packed} of ${line.required} packed`,
          detail: "Scan the next one.",
          sound: "ok",
          vibrate: false,
        };
      }
      const { packed, required } = taskUnits(res.task.lines);
      return {
        tone: "success",
        title: line && line.required > 1 ? `${name}: all ${line.required} packed` : `${name}: packed`,
        detail: packed >= required ? "Everything is packed. Tap Mark packed." : undefined,
        sound: "ok",
        vibrate: false,
      };
    }
    case "over":
      return {
        tone: "warning",
        title:
          line && line.required > 1
            ? `You already have all ${line.required} of ${name}`
            : `${name} is already packed`,
        detail: "Keep the extra one out of the parcel.",
        sound: "error",
        vibrate: false,
      };
    case "not_in_order":
      return {
        tone: "danger",
        title: res.product
          ? `${productName(res.product.title, res.product.variantTitle)} is not in this order`
          : "This item is not in this order",
        detail: "Put it back and pick the right item.",
        sound: "error",
        vibrate: true,
      };
    default:
      return {
        tone: "danger",
        title: `No product has the code ${code}`,
        detail: "Check the label, or confirm the item by hand.",
        sound: "error",
        vibrate: true,
      };
  }
}

// ── Finishing ───────────────────────────────────────────────────────────────

export interface FinishOptions {
  allPacked: boolean;
  packedUnits: number;
  requiredUnits: number;
  /** "Mark these packed, pack the rest later" is offered. */
  canPartial: boolean;
  /** Why it is not offered, when the order is short. */
  partialNote: string | null;
}

export function finishOptions(task: Pick<PackTask, "payment" | "partialAllowed" | "lines">): FinishOptions {
  const { packed, required } = taskUnits(task.lines);
  const allPacked = task.lines.every((l) => l.packed >= l.required);
  const base = { allPacked, packedUnits: packed, requiredUnits: required };
  if (allPacked) return { ...base, canPartial: false, partialNote: null };
  if (!task.partialAllowed) {
    return {
      ...base,
      canPartial: false,
      partialNote:
        task.payment === "cod"
          ? "Cash-on-delivery orders go out in one parcel. Splitting this one would mean the courier collects cash twice."
          : "This order isn't paid yet, so it goes out in one parcel.",
    };
  }
  if (packed === 0) {
    return { ...base, canPartial: false, partialNote: "Pack at least one item to send part of the order now." };
  }
  return { ...base, canPartial: true, partialNote: null };
}

// ── Queue rows ──────────────────────────────────────────────────────────────

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface PackingBadge {
  label: string;
  tone: BadgeTone;
}

export function paymentBadges(row: { payment: PackingPayment; codConfirmed: boolean | null }): PackingBadge[] {
  if (row.payment === "cod") {
    return row.codConfirmed === false
      ? [{ label: "COD", tone: "neutral" }, { label: "Not confirmed", tone: "warning" }]
      : [{ label: "COD", tone: "neutral" }];
  }
  return row.payment === "prepaid"
    ? [{ label: "Prepaid", tone: "success" }]
    : [{ label: "Not paid", tone: "warning" }];
}

/** Where the row's packing stands: progress, the hold reason, or packed. Null before anyone starts. */
export function taskBadge(task: PackingQueueRow["task"]): PackingBadge | null {
  if (!task) return null;
  switch (task.status) {
    case "PACKING":
      return { label: `${task.packedUnits} of ${task.requiredUnits} packed`, tone: "info" };
    case "ON_HOLD":
      return { label: `On hold: ${holdReasonLabel(task.holdReason).toLowerCase()}`, tone: "warning" };
    case "PACKED":
      return task.packedUnits < task.requiredUnits
        ? { label: `Packed ${task.packedUnits} of ${task.requiredUnits}`, tone: "success" }
        : { label: "Packed", tone: "success" };
    default:
      return null;
  }
}

/** Every badge a queue row shows, payment first. */
export function queueBadges(row: Pick<PackingQueueRow, "payment" | "codConfirmed" | "task">): PackingBadge[] {
  const status = taskBadge(row.task);
  return status ? [...paymentBadges(row), status] : paymentBadges(row);
}

// ── Order page ──────────────────────────────────────────────────────────────

/** "2:10 pm" today, "27 Oct, 2:10 pm" before. */
export function packedTime(iso: string, now: number = Date.now(), timeZone?: string): string {
  const at = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString("en-IN", { timeZone });
  const time = at.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone });
  if (day(at) === day(new Date(now))) return time;
  return `${at.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone })}, ${time}`;
}

/** The order page's one-line packing status. */
export function packingStatusLine(p: OrderPacking, now: number = Date.now(), timeZone?: string): string {
  switch (p.status) {
    case "PACKED": {
      const who = p.packedByName ? `Packed by ${p.packedByName}` : "Packed";
      const when = p.packedAt ? `, ${packedTime(p.packedAt, now, timeZone)}` : "";
      const part =
        p.packedUnits < p.requiredUnits ? ` (${p.packedUnits} of ${itemsWord(p.requiredUnits)}, the rest later)` : "";
      return `${who}${when}${part}`;
    }
    case "ON_HOLD":
      return `On hold: ${holdReasonLabel(p.holdReason).toLowerCase()}`;
    case "PACKING":
      return `Packing: ${p.packedUnits} of ${itemsWord(p.requiredUnits)} packed`;
    default:
      return "Not packed yet";
  }
}

/**
 * May this order be packed? Mirrors the queue's rule: open, not refunded or
 * voided, not fully shipped, not a counter sale, and something left to send.
 */
export function canStartPacking(
  order: {
    cancelledAt: string | null;
    closedAt?: string | null;
    financialStatus: FinancialStatus;
    fulfillmentStatus: FulfillmentStatus;
    sourceName?: string | null;
    posSale?: boolean;
  },
  hasUnitsLeft: boolean,
): boolean {
  return (
    !order.cancelledAt &&
    !order.closedAt &&
    order.financialStatus !== "REFUNDED" &&
    order.financialStatus !== "VOIDED" &&
    (order.fulfillmentStatus === "UNFULFILLED" || order.fulfillmentStatus === "PARTIAL") &&
    !order.posSale &&
    order.sourceName !== "pos" &&
    hasUnitsLeft
  );
}
