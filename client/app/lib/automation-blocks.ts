import {
  CircleCheck,
  Clock,
  FileText,
  GitBranch,
  Hourglass,
  MessageCircleReply,
  MessageSquare,
  PenLine,
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
  group: "Messages" | "Flow" | "Contact" | "Conversation" | "Connect";
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
  send_invoice: { label: "Send the invoice", icon: FileText, hint: "Arrives with store automations.", group: "Messages", unavailable: "Arrives with store automations" },
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
};

export const BLOCK_GROUPS: Array<BlockSpec["group"]> = ["Messages", "Flow", "Contact", "Conversation", "Connect"];

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
      return { id, type, config: { template: "gst_invoice", delivery: "whatsapp" } };
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
    default:
      return BLOCKS[step.type]?.hint ?? "";
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
