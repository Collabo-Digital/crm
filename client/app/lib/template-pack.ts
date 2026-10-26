/**
 * Display vocabulary for Collabo's recommended WhatsApp templates (the pack)
 * and the automations that send them. Pure.
 */
import type { AutomationPackState, PackSet, PackSlotKey, PackSlotState, TemplatePackView } from "~/types/api";

/**
 * Each slot's title and category, as the server's pack registry
 * (campaigns/templates/pack/template-pack.ts) has them, for screens that show
 * a slot without the pack view: a step's summary on the canvas, or a role
 * that cannot read Campaigns.
 */
export const PACK_SLOTS: Record<PackSlotKey, { title: string; category: "UTILITY" | "MARKETING" }> = {
  order_confirmed: { title: "Order confirmed", category: "UTILITY" },
  cod_confirm: { title: "Confirm a cash-on-delivery order", category: "UTILITY" },
  order_shipped: { title: "Order shipped", category: "UTILITY" },
  out_for_delivery: { title: "Out for delivery", category: "UTILITY" },
  order_delivered: { title: "Order delivered", category: "UTILITY" },
  order_cancelled: { title: "Order cancelled", category: "UTILITY" },
  refund_processed: { title: "Refund processed", category: "UTILITY" },
  gst_invoice: { title: "GST invoice", category: "UTILITY" },
  store_bill: { title: "Bill from the till", category: "UTILITY" },
  review_request: { title: "Review request", category: "UTILITY" },
  optin_confirmed: { title: "Subscription confirmed", category: "UTILITY" },
  payment_link: { title: "Payment link", category: "UTILITY" },
  pay_online: { title: "Pay online for a COD order", category: "UTILITY" },
  cart_reminder_1: { title: "Cart reminder 1", category: "MARKETING" },
  cart_reminder_2: { title: "Cart reminder 2", category: "MARKETING" },
  cart_reminder_3: { title: "Cart reminder 3 (with a discount)", category: "MARKETING" },
};

export const packSlotTitle = (slot: string): string => PACK_SLOTS[slot as PackSlotKey]?.title ?? slot.replace(/_/g, " ");

export const PACK_SET_LABEL: Record<PackSet, string> = {
  core: "Orders",
  payment: "Payments",
  online_store: "Online store",
};

export const PACK_SLOT_STATE_LABEL: Record<PackSlotState, string> = {
  approved: "Approved",
  pending: "In review",
  paused: "Paused",
  attention: "Needs attention",
  not_created: "Not created",
};

export const PACK_SLOT_STATE_CLASS: Record<PackSlotState, string> = {
  approved: "bg-success-subtle text-success",
  pending: "bg-info-subtle text-info",
  paused: "bg-warning-subtle text-warning",
  attention: "bg-danger-subtle text-danger",
  not_created: "bg-muted text-muted-foreground",
};

export const PACK_STATE_LABEL: Record<AutomationPackState, string> = {
  live: "Live",
  waiting: "Waiting for Meta",
  ready: "Ready to turn on",
  off: "Off",
  attention: "Needs attention",
  duplicate: "Held back",
};

export const PACK_STATE_CLASS: Record<AutomationPackState, string> = {
  live: "bg-success-subtle text-success",
  waiting: "bg-info-subtle text-info",
  ready: "bg-brand/30 text-brand-strong",
  off: "bg-muted text-muted-foreground",
  attention: "bg-danger-subtle text-danger",
  duplicate: "bg-warning-subtle text-warning",
};

/**
 * Pack automations that stay off until the merchant turns them on, even on a
 * new connection. Mirrors the server's managed-automations registry, where
 * only the review request is off by default.
 */
export const PACK_OFF_BY_DEFAULT = new Set(["review_request"]);

/** Submitted as utility, filed by Meta under marketing. */
export function approvedAsMarketing(t: { status: string; category: string; requestedCategory: string | null }): boolean {
  return t.status === "APPROVED" && t.category === "MARKETING" && t.requestedCategory === "UTILITY";
}

/** The pack is still being created, or Meta is still reviewing some of it. */
export function packBusy(view: TemplatePackView | undefined): boolean {
  const status = view?.pack?.status;
  return status === "pending" || status === "running" || (!!view?.pack && view.counts.pending > 0);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Where the pack stands, in a sentence or two. `noun` is what the merchant
 * calls them on the page: "templates" in Campaigns, "messages" in Settings.
 */
export function packProgress(view: TemplatePackView, noun: "templates" | "messages"): { tone: "info" | "success" | "warning" | "danger"; title: string; detail: string | null } {
  const { total, approved, pending, attention } = view.counts;
  const notCreated = view.slots.filter((s) => s.state === "not_created").length;
  const paused = view.slots.filter((s) => s.state === "paused").length;
  const pack = view.pack;
  if (!pack) return { tone: "info", title: `Collabo has not set up its recommended ${noun} on this WhatsApp account.`, detail: null };

  if (pack.status === "stopped") {
    return {
      tone: "warning",
      title: `Collabo stopped setting up your ${noun}: ${approved} of ${total} approved.`,
      detail: pack.stoppedReason,
    };
  }
  if (attention > 0) {
    return {
      tone: "danger",
      title: `${plural(attention, "template needs", "templates need")} attention: ${approved} of ${total} approved.`,
      detail: null,
    };
  }
  if (approved === total) return { tone: "success", title: `All ${total} ${noun} are approved.`, detail: null };

  const creating = pack.status === "pending" || pack.status === "running";
  const others = [
    ...(pending ? [`${pending} waiting for Meta (usually minutes, at most 24 hours)`] : []),
    ...(paused ? [`${paused} paused by Meta`] : []),
    ...(!creating && notCreated ? [`${notCreated} not created yet`] : []),
  ];
  const pausedDetail = paused ? "Meta pauses a template when many people block or report its messages. Automations wait to send it until the pause ends." : null;
  if (!creating && !pending) {
    return { tone: "warning", title: `${approved} of ${total} ${noun} approved, ${others.join(", ")}.`, detail: pausedDetail };
  }
  return {
    tone: "info",
    title: approved || pending ? `Setting up your ${noun}: ${[`${approved} approved`, ...others].join(", ")}.` : `Setting up your ${noun} on your WhatsApp account.`,
    detail: creating && notCreated ? `${plural(notCreated, "is", "are")} still being created.` : pausedDetail,
  };
}
