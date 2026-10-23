import {
  CircleCheck,
  Clock,
  CreditCard,
  FileText,
  GitBranch,
  Hourglass,
  MessageCircleReply,
  MessageSquare,
  PenLine,
  ShoppingBag,
  StickyNote,
  Tag,
  Tags,
  UserPlus,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  AutomationBlockType,
  AutomationChannelKey,
  AutomationPlatform,
  AutomationRunStatus,
  AutomationStatus,
  AutomationStep,
} from "~/types/api";

// ─── Blocks ─────────────────────────────────────────────────────────────────

export interface BlockSpec {
  label: string;
  icon: LucideIcon;
  hint: string;
  group: "Messages" | "Flow" | "Contact" | "Conversation" | "Store" | "Connect";
  /** Channels it works on; every channel when absent. */
  channels?: AutomationChannelKey[];
  /** Comment triggers only. */
  commentsOnly?: boolean;
  /** Shown but cannot be added yet. */
  unavailable?: string;
}

export const BLOCKS: Record<AutomationBlockType, BlockSpec> = {
  trigger: { label: "Starts when", icon: Zap, hint: "What starts this automation.", group: "Flow" },
  send_message: { label: "Send a message", icon: MessageSquare, hint: "Text, a file, buttons, a list or a WhatsApp template.", group: "Messages" },
  reply_comment: { label: "Reply to the comment", icon: MessageCircleReply, hint: "A private DM to the commenter, or a public reply.", group: "Messages", commentsOnly: true },
  send_invoice: { label: "Send the invoice", icon: FileText, hint: "The order’s GST invoice as a PDF on WhatsApp.", group: "Store", channels: ["whatsapp"] },
  send_payment_link: { label: "Send a payment link", icon: CreditCard, hint: "A Razorpay link for the order or cart, paid into your own account.", group: "Store", channels: ["whatsapp"] },
  wait: { label: "Wait", icon: Clock, hint: "Pause for minutes, hours or days.", group: "Flow" },
  wait_for_reply: { label: "Wait for a reply", icon: Hourglass, hint: "Go on when they answer, or another way if they don’t.", group: "Flow" },
  condition: { label: "Check a condition", icon: GitBranch, hint: "Split into yes and no.", group: "Flow" },
  add_tag: { label: "Add tags", icon: Tag, hint: "Tag the contact.", group: "Contact" },
  remove_tag: { label: "Remove tags", icon: Tags, hint: "Take tags off the contact.", group: "Contact" },
  set_attribute: { label: "Save a field", icon: PenLine, hint: "Store a value on the contact.", group: "Contact" },
  assign: { label: "Assign", icon: UserPlus, hint: "Hand the conversation to a person or team.", group: "Conversation" },
  set_status: { label: "Open, close or snooze", icon: CircleCheck, hint: "Change the conversation’s status.", group: "Conversation" },
  add_note: { label: "Add a note", icon: StickyNote, hint: "A private note for the team.", group: "Conversation" },
  http_request: { label: "Call a URL", icon: Webhook, hint: "Send data to another system and use its answer.", group: "Connect" },
  store_action: { label: "Store action", icon: ShoppingBag, hint: "Tag, note or cancel the order, or turn a cart into a draft order.", group: "Store", channels: ["whatsapp"] },
};

export const BLOCK_GROUPS: Array<BlockSpec["group"]> = ["Messages", "Flow", "Contact", "Conversation", "Store", "Connect"];

/** Store triggers: the order or checkout they are about gives {{order.*}} or {{checkout.*}}. */
export const ORDER_EVENTS = ["order_created", "order_paid", "order_fulfilled", "order_delivered", "order_cancelled", "invoice_issued", "payment_received"];
export const STORE_EVENTS = [...ORDER_EVENTS, "checkout_abandoned"];

export const BRANCH_LABEL: Partial<Record<AutomationBlockType, Record<string, string>>> = {
  condition: { yes: "Yes", no: "No" },
  wait_for_reply: { replied: "They replied", timeout: "No reply" },
};

export const MAX_STEPS = 40;
export const MAX_DEPTH = 4;

export const channelKeyOf = (platform: AutomationPlatform | null | undefined): AutomationChannelKey =>
  platform === "WHATSAPP" ? "whatsapp" : platform === "FACEBOOK" ? "facebook" : "instagram";

export const CHANNEL_LABEL: Record<AutomationChannelKey, string> = { instagram: "Instagram", whatsapp: "WhatsApp", facebook: "Messenger" };

/** Trigger events each channel offers, with the words the builder uses. */
export const EVENTS: Record<AutomationChannelKey, Array<{ value: string; label: string; hint: string }>> = {
  instagram: [
    { value: "comment", label: "Someone comments on a post", hint: "On one post or reel, or any." },
    { value: "message", label: "Someone sends a DM", hint: "Any message, or one with a keyword." },
    { value: "mention", label: "Someone mentions you in their story", hint: "" },
    { value: "postback", label: "Someone taps an ice breaker or menu item", hint: "Set these up under Conversation starters." },
    { value: "tag_added", label: "A contact gets a tag", hint: "" },
    { value: "webhook", label: "Another app calls a URL", hint: "" },
  ],
  facebook: [
    { value: "comment", label: "Someone comments on a Page post", hint: "" },
    { value: "message", label: "Someone sends a message", hint: "" },
    { value: "postback", label: "Someone taps Get Started, an ice breaker or a menu item", hint: "Set these up under Conversation starters." },
    { value: "tag_added", label: "A contact gets a tag", hint: "" },
    { value: "webhook", label: "Another app calls a URL", hint: "" },
  ],
  whatsapp: [
    { value: "message", label: "Someone sends a message", hint: "Any message, or one with a keyword." },
    { value: "cart", label: "Someone sends a cart from your catalog", hint: "Turn it into a draft order with a checkout link." },
    { value: "order_created", label: "An order is placed", hint: "In Shopify or in Collabo." },
    { value: "order_paid", label: "An order is paid", hint: "" },
    { value: "invoice_issued", label: "A GST invoice is issued", hint: "On payment or when a cash-on-delivery order ships (with automatic invoices on), by hand, in bulk, or with an offline sale. Send it with “Send the invoice”." },
    { value: "payment_received", label: "A payment link is paid", hint: "A Razorpay link sent in chat, by your team or by “Send a payment link”. The amount is in {{payment.amount}}." },
    { value: "order_fulfilled", label: "An order ships", hint: "Tracking details are in {{order.tracking_url}}." },
    { value: "order_delivered", label: "An order is delivered", hint: "When the carrier or your team marks it delivered." },
    { value: "order_cancelled", label: "An order is cancelled", hint: "" },
    { value: "checkout_abandoned", label: "A checkout is left unfinished", hint: "An hour after a Shopify checkout with a phone number goes quiet." },
    { value: "tag_added", label: "A contact gets a tag", hint: "" },
    { value: "webhook", label: "Another app calls a URL", hint: "For example your order tool, with the customer’s phone number." },
  ],
};

let counter = 0;
export function newStepId(): string {
  counter = (counter + 1) % 1296;
  return `s_${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(2, "0")}`;
}

/** A new block with the same defaults the server fills in. */
export function newStep(type: AutomationBlockType, channel: AutomationChannelKey): AutomationStep {
  const id = newStepId();
  switch (type) {
    case "send_message":
      return { id, type, config: { kind: "text", message: "", options: [], listButton: "Choose", templateValues: {} } };
    case "reply_comment":
      return { id, type, config: { mode: "private", message: "" } };
    case "wait":
      return { id, type, config: { amount: 1, unit: "hours" } };
    case "wait_for_reply":
      return { id, type, config: { amount: 24, unit: "hours", saveAs: "" }, branches: { replied: [], timeout: [] } };
    case "condition":
      return { id, type, config: { match: "all", rules: [{ field: "last_reply", op: "contains", key: "", value: "" }] }, branches: { yes: [], no: [] } };
    case "add_tag":
    case "remove_tag":
      return { id, type, config: { tags: [] } };
    case "set_attribute":
      return { id, type, config: { key: "", value: "" } };
    case "assign":
      return { id, type, config: { mode: "round_robin", userId: "", teamId: "" } };
    case "set_status":
      return { id, type, config: { status: "closed", hours: 24 } };
    case "add_note":
      return { id, type, config: { text: "" } };
    case "http_request":
      return { id, type, config: { method: "POST", url: "", body: "", saveAs: "" } };
    case "send_invoice":
      return { id, type, config: { templateValues: {} } };
    case "send_payment_link":
      return { id, type, config: { method: "link", kind: "template", message: "", templateValues: {}, expiresInHours: 48, tagOnPaid: "" } };
    case "store_action":
      return { id, type, config: { action: "tag_order", value: "" } };
    default:
      return { id, type: "trigger", config: { channel, event: channel === "whatsapp" ? "message" : "comment", match: "contains", keyword: "", post: "" } };
  }
}

// ─── Tree helpers (pure) ────────────────────────────────────────────────────

/** Where a block goes: a position in the top list or in a branch of a block. */
export interface Slot {
  parentId: string | null;
  branch: string | null;
  index: number;
}

const mapLists = (steps: AutomationStep[], fn: (list: AutomationStep[], parentId: string | null, branch: string | null) => AutomationStep[]): AutomationStep[] => {
  const walk = (list: AutomationStep[], parentId: string | null, branch: string | null): AutomationStep[] =>
    fn(list, parentId, branch).map((s) =>
      s.branches ? { ...s, branches: Object.fromEntries(Object.entries(s.branches).map(([name, l]) => [name, walk(l, s.id, name)])) } : s,
    );
  return walk(steps, null, null);
};

export function findStep(steps: AutomationStep[], id: string): AutomationStep | null {
  for (const s of steps) {
    if (s.id === id) return s;
    for (const list of Object.values(s.branches ?? {})) {
      const found = findStep(list, id);
      if (found) return found;
    }
  }
  return null;
}

export function updateStep(steps: AutomationStep[], id: string, config: Record<string, unknown>): AutomationStep[] {
  return mapLists(steps, (list) => list.map((s) => (s.id === id ? { ...s, config } : s)));
}

export function insertStep(steps: AutomationStep[], slot: Slot, step: AutomationStep): AutomationStep[] {
  return mapLists(steps, (list, parentId, branch) =>
    parentId === slot.parentId && branch === slot.branch ? [...list.slice(0, slot.index), step, ...list.slice(slot.index)] : list,
  );
}

export function removeStep(steps: AutomationStep[], id: string): AutomationStep[] {
  return mapLists(steps, (list) => list.filter((s) => s.id !== id));
}

/** Move a block up or down among its siblings. The trigger stays first. */
export function moveStep(steps: AutomationStep[], id: string, by: -1 | 1): AutomationStep[] {
  return mapLists(steps, (list, parentId) => {
    const i = list.findIndex((s) => s.id === id);
    const j = i + by;
    if (i < 0 || j < (parentId === null ? 1 : 0) || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
}

export function countSteps(steps: AutomationStep[]): number {
  return steps.reduce((n, s) => n + 1 + Object.values(s.branches ?? {}).reduce((m, l) => m + countSteps(l), 0), 0);
}

/** How deep a branch list sits: 0 for the top list. */
export function depthOf(steps: AutomationStep[], parentId: string | null): number {
  if (!parentId) return 0;
  const walk = (list: AutomationStep[], depth: number): number => {
    for (const s of list) {
      if (s.id === parentId) return depth + 1;
      for (const l of Object.values(s.branches ?? {})) {
        const d = walk(l, depth + 1);
        if (d) return d;
      }
    }
    return 0;
  };
  return walk(steps, 0);
}

/** Every step id in a list, with nested ones. */
export function allSteps(steps: AutomationStep[]): AutomationStep[] {
  return steps.flatMap((s) => [s, ...Object.values(s.branches ?? {}).flatMap(allSteps)]);
}

// ─── Words ──────────────────────────────────────────────────────────────────

const UNIT: Record<string, [string, string]> = { minutes: ["minute", "minutes"], hours: ["hour", "hours"], days: ["day", "days"] };
export const duration = (amount: number, unit: string) => `${amount} ${UNIT[unit]?.[amount === 1 ? 0 : 1] ?? unit}`;

export function triggerSummary(config: AutomationStep["config"]): string {
  const keywords = String(config.keyword ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const words = keywords.length ? keywords.map((k) => `“${k}”`).join(", ") : "";
  switch (config.event) {
    case "comment":
      return `${config.post ? "A comment on the chosen post" : "A comment on any post"}${config.match === "any" || !words ? "" : ` with ${words}`}`;
    case "message":
      return `${config.newConversationOnly ? "The first message of a conversation" : "A message"}${config.match === "any" || !words ? "" : config.match === "exact" ? ` that is exactly ${words}` : ` with ${words}`}`;
    case "mention":
      return "A story mention";
    case "postback":
      return config.match === "any" || !words ? "Any button tap" : `A tap on ${words}`;
    case "tag_added":
      return config.tag ? `The tag “${config.tag}” is added` : "A tag is added";
    case "webhook":
      return "A call to this automation’s URL";
    case "cart":
      return "A cart from the catalog";
    case "checkout_abandoned":
      return "An unfinished checkout";
    case "order_created":
      return "A new order";
    case "order_paid":
      return "An order is paid";
    case "invoice_issued":
      return "A GST invoice is issued";
    case "payment_received":
      return "A payment link is paid";
    case "order_fulfilled":
      return "An order ships";
    case "order_delivered":
      return "An order is delivered";
    case "order_cancelled":
      return "An order is cancelled";
    default:
      return "Choose what starts it";
  }
}

export function stepSummary(step: AutomationStep, templateName?: (id: string) => string | undefined): string {
  const c = step.config;
  const clip = (text: string, n = 90) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  switch (step.type) {
    case "trigger":
      return triggerSummary(c);
    case "send_message": {
      if (c.kind === "template") return c.templateId ? `Template “${templateName?.(c.templateId) ?? "…"}”` : "Choose a template";
      if (c.kind === "media") return c.media ? `${c.media.filename ?? c.media.kind}${c.message ? ` · ${clip(c.message, 50)}` : ""}` : "Add a file";
      const options = (c.options ?? []).filter((o: string) => o.trim());
      return `${c.message ? clip(c.message) : "Write the message"}${options.length ? ` · ${options.join(" / ")}` : ""}`;
    }
    case "reply_comment":
      return `${c.mode === "public" ? "Public" : "Private"}: ${c.message ? clip(c.message) : "write the reply"}`;
    case "wait":
      return `For ${duration(c.amount, c.unit)}`;
    case "wait_for_reply":
      return `Up to ${duration(c.amount, c.unit)}${c.saveAs ? ` · saved as ${c.saveAs}` : ""}`;
    case "condition":
      return `${c.rules?.length ?? 0} rule${c.rules?.length === 1 ? "" : "s"}, ${c.match === "any" ? "any" : "all"} must match`;
    case "add_tag":
    case "remove_tag":
      return c.tags?.length ? c.tags.join(", ") : "Choose tags";
    case "set_attribute":
      return c.key ? `${c.key} = ${clip(String(c.value ?? ""), 50)}` : "Name the field";
    case "assign":
      return c.mode === "round_robin" ? "Next available agent" : c.mode === "unassign" ? "Unassign" : c.mode === "team" ? "Queue for a team" : "A team member";
    case "set_status":
      return c.status === "snoozed" ? `Snooze ${duration(c.hours, "hours")}` : c.status === "open" ? "Open" : "Close";
    case "add_note":
      return c.text ? clip(c.text) : "Write the note";
    case "http_request":
      return c.url ? `${c.method} ${clip(c.url, 60)}` : "Add the URL";
    case "send_invoice":
      return c.templateId ? `The invoice PDF with “${templateName?.(c.templateId) ?? "a template"}”` : "Choose the template";
    case "send_payment_link":
      if (c.method === "whatsapp_pay") return "A WhatsApp Pay bill in the chat";
      if (c.kind === "text") return c.message ? clip(c.message) : "Write the message";
      return c.templateId ? `A payment link with “${templateName?.(c.templateId) ?? "a template"}”` : "Choose a template";
    case "store_action":
      return (
        {
          tag_order: c.value ? `Tag the order “${c.value}”` : "Tag the order",
          note_order: c.value ? `Note on the order: ${clip(c.value, 50)}` : "Add a note to the order",
          cancel_order: "Cancel the order",
          tag_customer: c.value ? `Tag the customer “${c.value}”` : "Tag the customer",
          create_draft_order: "Make a draft order with a checkout link",
        } as Record<string, string>
      )[c.action] ?? "Store action";
    default:
      return BLOCKS[(step as AutomationStep).type]?.hint ?? "";
  }
}

export const AUTOMATION_STATUS_LABEL: Record<AutomationStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Live",
  PAUSED: "Paused",
  ERROR: "Needs attention",
  ARCHIVED: "Archived",
};

export const AUTOMATION_STATUS_CLASS: Record<AutomationStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  ACTIVE: "bg-success-subtle text-success",
  PAUSED: "bg-warning-subtle text-warning",
  ERROR: "bg-danger-subtle text-danger",
  ARCHIVED: "bg-muted text-muted-foreground",
};

export const RUN_STATUS_LABEL: Record<AutomationRunStatus, string> = {
  PENDING: "Starting",
  RUNNING: "Running",
  WAITING: "Waiting",
  COMPLETED: "Finished",
  FAILED: "Stopped",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
};

export const RUN_STATUS_CLASS: Record<AutomationRunStatus, string> = {
  PENDING: "bg-info-subtle text-info",
  RUNNING: "bg-info-subtle text-info",
  WAITING: "bg-brand/30 text-brand-strong",
  COMPLETED: "bg-success-subtle text-success",
  FAILED: "bg-danger-subtle text-danger",
  SKIPPED: "bg-muted text-muted-foreground",
  CANCELLED: "bg-muted text-muted-foreground",
};

export const SKIP_REASON_LABEL: Record<string, string> = {
  once_per_contact: "Already went through it",
  once_per_day: "Already went through it today",
};

// ─── Playbooks ──────────────────────────────────────────────────────────────

export interface Playbook {
  key: string;
  name: string;
  description: string;
  channels: AutomationChannelKey[];
  steps: (channel: AutomationChannelKey) => AutomationStep[];
}

/**
 * Template values under both kinds of key: {{1}}, {{2}}… for a template of
 * your own, and the names the matching starter template uses ({{first_name}}…).
 * A send reads only the keys its template has.
 */
const prefill = (named: Record<string, string>): Record<string, string> => ({
  ...Object.fromEntries(Object.values(named).map((v, i) => [`body.${i + 1}`, v])),
  ...Object.fromEntries(Object.entries(named).map(([k, v]) => [`body.${k}`, v])),
});
const t = (channel: AutomationChannelKey, config: Record<string, unknown>): AutomationStep => ({ id: newStepId(), type: "trigger", config: { channel, post: "", match: "contains", keyword: "", ...config } });
const s = (type: AutomationBlockType, config: Record<string, unknown>, branches?: Record<string, AutomationStep[]>): AutomationStep => ({
  id: newStepId(),
  type,
  config,
  ...(branches ? { branches } : {}),
});

/** Starting points with our own copy. Every one opens as a draft to adjust before publishing. */
export const PLAYBOOKS: Playbook[] = [
  {
    key: "comment_link",
    name: "Comment for the link",
    description: "Someone comments a keyword on a post; they get a private DM, and the link once they reply.",
    channels: ["instagram", "facebook"],
    steps: (channel) => [
      t(channel, { event: "comment", keyword: "link, price" }),
      s("reply_comment", { mode: "private", message: "Hi {{first_name}}! Thanks for asking. Want me to send the link here? Reply YES." }),
      s("reply_comment", { mode: "public", message: "Sent you a DM 📩" }),
      s("wait_for_reply", { amount: 24, unit: "hours", saveAs: "" }, {
        replied: [s("send_message", { kind: "text", message: "Here you go: https://your-store.example/product", options: [], templateValues: {} }), s("add_tag", { tags: ["interested"] })],
        timeout: [],
      }),
    ],
  },
  {
    key: "story_thanks",
    name: "Thank story mentions",
    description: "A warm thank-you DM whenever someone mentions you in their story.",
    channels: ["instagram"],
    steps: (channel) => [
      t(channel, { event: "mention" }),
      s("send_message", { kind: "text", message: "Thank you for the shout-out, {{first_name}}! 💛 Here’s 10% off your next order: THANKYOU10", options: [], templateValues: {} }),
      s("add_tag", { tags: ["story-mention"] }),
    ],
  },
  {
    key: "keyword_reply",
    name: "Answer a common question",
    description: "Reply instantly when a message mentions shipping, delivery or returns.",
    channels: ["whatsapp", "instagram", "facebook"],
    steps: (channel) => [
      t(channel, { event: "message", keyword: "shipping, delivery" }),
      s("send_message", { kind: "text", message: "We ship across India in 3–5 working days. Orders over ₹999 ship free.", options: [], templateValues: {} }),
    ],
  },
  {
    key: "order_status",
    name: "Order status lookup",
    description: "Ask what they need with buttons, look the order up in your system, and reply with its status.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "message", keyword: "order status, where is my order" }),
      s("send_message", { kind: "buttons", message: "Hi {{first_name}}, how can we help with your order?", options: ["Track my order", "Talk to someone"], templateValues: {} }),
      s("wait_for_reply", { amount: 2, unit: "hours", saveAs: "" }, {
        replied: [
          s("condition", { match: "all", rules: [{ field: "last_reply", op: "equals", key: "", value: "Track my order" }] }, {
            yes: [
              s("http_request", { method: "POST", url: "https://your-system.example/order-status", body: '{"phone":"{{phone}}"}', saveAs: "order" }),
              s("send_message", { kind: "text", message: "Your order is {{order.status}}.", options: [], templateValues: {} }),
            ],
            no: [s("assign", { mode: "round_robin", userId: "", teamId: "" }), s("set_status", { status: "open", hours: 24 })],
          }),
        ],
        timeout: [],
      }),
    ],
  },
  {
    key: "lead_qualifier",
    name: "Qualify new leads",
    description: "Greet the first message, ask one question, save the answer and route serious buyers to the team.",
    channels: ["whatsapp", "instagram", "facebook"],
    steps: (channel) => [
      t(channel, { event: "message", match: "any", newConversationOnly: true }),
      s("send_message", { kind: channel === "whatsapp" ? "buttons" : "quick_replies", message: "Hi {{first_name}}! What brings you here today?", options: ["Buying for myself", "Bulk order", "Just browsing"], templateValues: {} }),
      s("wait_for_reply", { amount: 1, unit: "days", saveAs: "intent" }, {
        replied: [
          s("condition", { match: "all", rules: [{ field: "last_reply", op: "contains", key: "", value: "bulk" }] }, {
            yes: [s("add_tag", { tags: ["bulk-lead"] }), s("assign", { mode: "round_robin", userId: "", teamId: "" }), s("add_note", { text: "Bulk enquiry from {{first_name}}" })],
            no: [s("add_tag", { tags: ["lead"] })],
          }),
        ],
        timeout: [s("add_tag", { tags: ["no-reply"] })],
      }),
    ],
  },
  {
    key: "vip_tag",
    name: "When someone becomes VIP",
    description: "Tagging a contact VIP saves their tier, notes it for the team and hands them to a person.",
    channels: ["whatsapp", "instagram", "facebook"],
    steps: (channel) => [
      t(channel, { event: "tag_added", tag: "VIP" }),
      s("set_attribute", { key: "tier", value: "vip" }),
      s("assign", { mode: "round_robin", userId: "", teamId: "" }),
      s("add_note", { text: "{{first_name}} is now VIP — give them priority." }),
    ],
  },
  {
    key: "order_confirmation",
    name: "Order confirmation",
    description: "Thank the customer on WhatsApp the moment an order is placed, with its number and total.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "order_created" }),
      s("send_message", { kind: "template", templateValues: prefill({ first_name: "{{first_name}}", order_number: "{{order.name}}", order_total: "{{order.total}}" }), options: [] }),
    ],
  },
  {
    key: "invoice_after_purchase",
    name: "Send the GST invoice",
    description: "After each purchase, send the customer their GST invoice as a PDF on WhatsApp, as soon as it is issued.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "invoice_issued" }),
      s("send_invoice", {
        templateValues: prefill({ first_name: "{{first_name}}", order_number: "{{order.name}}", invoice_number: "{{invoice.number}}", invoice_total: "{{invoice.total}}" }),
      }),
    ],
  },
  {
    key: "shipping_update",
    name: "Shipping update",
    description: "Tell customers their order is on the way, with the tracking link.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "order_fulfilled" }),
      // As the "Order shipped" starter: name, order, carrier, and the tracking number after the link's address.
      s("send_message", { kind: "template", templateValues: { "body.1": "{{first_name}}", "body.2": "{{order.name}}", "body.3": "{{order.carrier}}", "button.0": "{{order.tracking_number}}" }, options: [] }),
    ],
  },
  {
    key: "cod_confirmation",
    name: "Confirm cash-on-delivery orders",
    description: "Ask COD buyers to confirm with a button; tag confirmed orders, cancel the ones they cancel and pass anything else to the team.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "order_created" }),
      s("condition", { match: "all", rules: [{ field: "order_payment", op: "is", key: "", value: "cod" }] }, {
        yes: [
          s("send_message", { kind: "template", templateValues: prefill({ first_name: "{{first_name}}", order_number: "{{order.name}}", order_total: "{{order.total}}" }), options: [] }),
          s("wait_for_reply", { amount: 24, unit: "hours", saveAs: "" }, {
            replied: [
              // Whole replies only (the template's buttons, or the word alone): "Please don't cancel" or
              // "When will it arrive?" must not decide the order, so anything else goes to the team.
              s("condition", { match: "all", rules: [{ field: "last_reply", op: "equals", key: "", value: "confirm, confirm order, yes" }] }, {
                yes: [s("store_action", { action: "tag_order", value: "cod-confirmed" })],
                no: [
                  s("condition", { match: "all", rules: [{ field: "last_reply", op: "equals", key: "", value: "cancel, cancel order, cancel my order" }] }, {
                    yes: [s("store_action", { action: "cancel_order", value: "Customer declined on WhatsApp" }), s("add_note", { text: "{{first_name}} cancelled {{order.name}} on WhatsApp" })],
                    no: [
                      s("store_action", { action: "tag_order", value: "cod-check" }),
                      s("assign", { mode: "round_robin", userId: "", teamId: "" }),
                      s("add_note", { text: "{{first_name}} replied about {{order.name}} without confirming: “{{last_reply}}”" }),
                    ],
                  }),
                ],
              }),
            ],
            timeout: [s("store_action", { action: "tag_order", value: "cod-unconfirmed" })],
          }),
        ],
        no: [],
      }),
    ],
  },
  {
    key: "cod_to_prepaid",
    name: "Turn COD orders into prepaid",
    description: "Offer cash-on-delivery buyers a Razorpay link to pay online now. A paid order is marked paid, in Shopify too, and tagged cod-to-prepaid.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "order_created" }),
      s("condition", { match: "all", rules: [{ field: "order_payment", op: "is", key: "", value: "cod" }] }, {
        yes: [
          // As the "Pay online instead of cash" starter: the link's path goes after https://rzp.io/ in the button.
          s("send_payment_link", {
            kind: "template",
            message: "",
            templateValues: { ...prefill({ first_name: "{{first_name}}", order_number: "{{order.name}}", order_total: "{{order.total}}" }), "button.0": "{{payment.link_path}}" },
            expiresInHours: 48,
            tagOnPaid: "cod-to-prepaid",
          }),
        ],
        no: [],
      }),
    ],
  },
  {
    key: "payment_thanks",
    name: "Thank buyers when they pay",
    description: "When a payment link is paid, note it for the team and thank the buyer.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "payment_received" }),
      s("add_note", { text: "{{first_name}} paid {{payment.amount}} by {{payment.method}} for {{payment.description}}" }),
      s("send_message", { kind: "template", templateValues: prefill({ first_name: "{{first_name}}", order_number: "{{order.name}}" }), options: [] }),
    ],
  },
  {
    key: "cart_recovery",
    name: "Recover unfinished checkouts",
    description: "Remind shoppers who left a checkout, with Shopify’s link back to their cart.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "checkout_abandoned" }),
      // A link button adds {{1}} to the store's address, so it gets the part of Shopify's link after it.
      s("send_message", { kind: "template", templateValues: { "body.1": "{{first_name}}", "button.0": "{{checkout.url_path}}" }, options: [] }),
      s("add_tag", { tags: ["abandoned-checkout"] }),
    ],
  },
  {
    key: "review_request",
    name: "Ask for a review after delivery",
    description: "Two days after delivery, ask how it went and tag happy customers.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "order_delivered" }),
      s("wait", { amount: 2, unit: "days" }),
      s("send_message", { kind: "template", templateValues: prefill({ first_name: "{{first_name}}", order_number: "{{order.name}}" }), options: [] }),
      s("wait_for_reply", { amount: 3, unit: "days", saveAs: "review" }, {
        replied: [
          s("condition", { match: "any", rules: [{ field: "last_reply", op: "contains", key: "", value: "love, great, good, 5" }] }, {
            yes: [s("add_tag", { tags: ["happy-customer"] })],
            no: [s("assign", { mode: "round_robin", userId: "", teamId: "" }), s("add_note", { text: "Unhappy after delivery: {{last_reply}}" })],
          }),
        ],
        timeout: [],
      }),
    ],
  },
  {
    key: "cart_to_checkout",
    name: "Cart to checkout",
    description: "When someone sends a cart from your WhatsApp catalog, make a draft order and reply with the checkout link.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "cart" }),
      s("store_action", { action: "create_draft_order", value: "" }),
      s("send_message", { kind: "text", message: "Thanks {{first_name}}! Your order comes to {{draft.total}}. Complete it here: {{draft.checkout_url}}", options: [], templateValues: {} }),
    ],
  },
  {
    key: "cart_to_payment",
    name: "Cart to payment",
    description: "When someone sends a cart from your WhatsApp catalog, make a draft order and reply with a Razorpay payment link. Paying it turns the draft into an order.",
    channels: ["whatsapp"],
    steps: (channel) => [
      t(channel, { event: "cart" }),
      s("store_action", { action: "create_draft_order", value: "" }),
      s("send_payment_link", { kind: "text", message: "Thanks {{first_name}}! Your order comes to {{payment.amount}}. Pay securely here: {{payment.link}}", templateValues: {}, expiresInHours: 24, tagOnPaid: "" }),
    ],
  },
  {
    key: "talk_to_person",
    name: "Talk to a person",
    description: "A menu tap or the word “agent” hands the chat to the next available teammate.",
    channels: ["facebook", "instagram"],
    steps: (channel) => [
      t(channel, { event: "postback", match: "exact", keyword: "TALK_TO_PERSON" }),
      s("send_message", { kind: "text", message: "Connecting you with our team — someone will reply shortly.", options: [], templateValues: {} }),
      s("assign", { mode: "round_robin", userId: "", teamId: "" }),
      s("set_status", { status: "open", hours: 24 }),
    ],
  },
];
