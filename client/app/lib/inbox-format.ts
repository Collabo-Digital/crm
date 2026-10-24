/**
 * Display formatting for the inbox.
 *
 * Pure, and every function that needs the current time takes it as an argument
 * — same rule as lib/session-window.ts, for the same reason.
 */

import type {
  ChannelPlatform,
  InboxConversationDetail,
  InboxMessage,
  InboxMessageKind,
  InboxMessageStatus,
  InboxNote,
  InboxPresence,
  MessageSource,
} from "~/types/api";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * List-row timestamp: "now" · "14m" · "3h" · "Yesterday" · "12 Aug".
 *
 * Deliberately terse — the column is ~40px and a row already carries a name,
 * a preview, tags and an assignee competing for the same glance.
 */
export function formatRowTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";

  const diff = now - then;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (isYesterday(then, now)) return "Yesterday";

  return new Date(then).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Bubble timestamp — always a clock time, since the day separator carries the date. */
/**
 * Why a free-form reply (text, file, products) cannot go in this conversation
 * now, if it cannot. A comment reply is not bound by the messaging window.
 */
export function replyBlockedReason(
  conversation: Pick<InboxConversationDetail, "platform" | "window" | "reply"> & { contact: Pick<InboxConversationDetail["contact"], "blockedAt"> },
  now: number,
  commentReply = false,
): string | null {
  if (!conversation.reply.canReply) return "You have view-only access to the inbox.";
  if (conversation.contact.blockedAt) return "This contact is blocked. Open contact details to unblock them.";
  if (commentReply) return null;
  const { phase } = windowPhase(conversation.platform, conversation.window, now);
  if (phase === "template_only") return "The 24-hour reply window has closed. Only an approved template can restart this conversation.";
  if (phase === "closed" || phase === "none") return "Messenger and Instagram allow replies for 7 days after the customer’s last message. Wait for them to write again.";
  return null;
}

/** Who wrote a note: the member, an automation, an inbox rule, or a member who has since left. */
export function noteAuthor(note: Pick<InboxNote, "author" | "source">): string {
  if (note.author) return note.author.name;
  return note.source === "automation" ? "Automation" : note.source === "inbox_rule" ? "Inbox rule" : "Former member";
}

export function formatBubbleTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "12 Aug 2026, 14:05" — for tooltips and the contact panel. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Day-separator label: "Today" · "Yesterday" · "Tue, 12 Aug". */
export function formatDaySeparator(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  if (isSameDay(then, now)) return "Today";
  if (isYesterday(then, now)) return "Yesterday";
  return new Date(then).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

/** Stable YYYY-MM-DD key for grouping a thread into days, in local time. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid";
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function isYesterday(then: number, now: number): boolean {
  return isSameDay(then, now - DAY);
}

/** Delivery-receipt wording under an outbound bubble. */
export const MESSAGE_STATUS_LABEL: Record<InboxMessageStatus, string> = {
  QUEUED: "Sending…",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Not sent",
};

/**
 * Who sent an outbound message, when it was not the agent reading the
 * thread. Shown under the bubble so a phone-app reply or an automation
 * never passes for something a colleague typed.
 */
export const SOURCE_LABEL: Partial<Record<MessageSource, string>> = {
  AUTOMATION: "Automation",
  BROADCAST: "Broadcast",
  BUSINESS_APP: "WhatsApp Business app",
  OTHER_APP: "Another app",
  SYSTEM: "Collabo",
};

export const PRESENCE_LABEL: Record<InboxPresence, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};

export const PRESENCE_DOT: Record<InboxPresence, string> = {
  online: "bg-success",
  away: "bg-warning",
  offline: "bg-muted-foreground/40",
};

/** Messages that are media files rather than text. */
export const MEDIA_KINDS: InboxMessageKind[] = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "STICKER"];

/** "2.4 MB" · "380 KB". */
export function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Two-letter initials for an avatar fallback. A contact known only by a phone
 * number has no letters to show, so it gets "#" rather than a stray "+".
 */
export function getInitials(name: string): string {
  const letters = name
    .replace(/^@/, "")
    .split(/\s+/)
    .map((part) => part.match(/\p{L}/u)?.[0] ?? "")
    .join("");
  return letters.slice(0, 2).toUpperCase() || "#";
}

/**
 * The reply window as the composer and header describe it.
 *
 * WhatsApp: free-form for 24 hours after the customer's last message, then
 * templates only. Messenger and Instagram: 24 hours, then a person (not an
 * automation) may still reply for up to 7 days.
 */
export type WindowPhase =
  | { phase: "open"; until: string }
  | { phase: "human_agent"; until: string }
  | { phase: "template_only" }
  | { phase: "closed" }
  /** The customer has never written: nothing to reply to yet. */
  | { phase: "none" };

export function windowPhase(
  platform: ChannelPlatform,
  window: { open: boolean; closesAt: string | null; humanAgentUntil: string | null },
  now: number,
): WindowPhase {
  if (!window.closesAt) return platform === "WHATSAPP" ? { phase: "template_only" } : { phase: "none" };
  if (new Date(window.closesAt).getTime() > now) return { phase: "open", until: window.closesAt };
  if (platform === "WHATSAPP") return { phase: "template_only" };
  if (window.humanAgentUntil && new Date(window.humanAgentUntil).getTime() > now) {
    return { phase: "human_agent", until: window.humanAgentUntil };
  }
  return { phase: "closed" };
}

/**
 * One item in the rendered thread.
 *
 * Messages and notes are separate entities but share one chronological
 * column, so the render pass needs a discriminated union rather than two
 * interleaved lists. Reactions are not items: they decorate the message they
 * react to.
 */
export type ThreadItem =
  | { kind: "message"; at: string; message: InboxMessage }
  | { kind: "note"; at: string; note: InboxNote };

/** One rendered day, with its items already in order. */
export interface ThreadDay {
  key: string;
  label: string;
  items: ThreadItem[];
}

/**
 * Merge messages and notes into day-grouped, chronologically ordered items.
 *
 * Ties break messages-before-notes: a note is almost always written *about* the
 * message that prompted it, so on an identical timestamp that order reads right.
 */
export function buildThreadDays(messages: InboxMessage[], notes: InboxNote[], now: number): ThreadDay[] {
  const items: ThreadItem[] = [
    ...messages
      .filter((message) => message.kind !== "REACTION")
      .map((message): ThreadItem => ({ kind: "message", at: message.createdAt, message })),
    ...notes.map((note): ThreadItem => ({ kind: "note", at: note.createdAt, note })),
  ];

  items.sort((a, b) => {
    const delta = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (delta !== 0) return delta;
    if (a.kind === b.kind) return 0;
    return a.kind === "message" ? -1 : 1;
  });

  const days: ThreadDay[] = [];
  for (const item of items) {
    const key = dayKey(item.at);
    const last = days[days.length - 1];
    if (last?.key === key) {
      last.items.push(item);
    } else {
      days.push({ key, label: formatDaySeparator(item.at, now), items: [item] });
    }
  }
  return days;
}

/**
 * Fill a quick reply's placeholders: {{name}} is the contact's first name,
 * {{agent}} the sender's. Unknown placeholders are left for the agent to see.
 */
export function fillQuickReply(body: string, values: { name: string; agent: string }): string {
  const first = (s: string) => s.replace(/^@/, "").split(/\s+/)[0] ?? "";
  return body.replace(/\{\{\s*(name|agent)\s*\}\}/gi, (_match, key: string) =>
    key.toLowerCase() === "name" ? first(values.name) : first(values.agent),
  );
}
