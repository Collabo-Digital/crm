import type { ChannelMessagingStatus } from "~/types/api";

/** WhatsApp number quality, as Meta rates it, with the badge tone to show. */
export function qualityMeta(quality: string | null): { label: string; className: string } | null {
  switch (quality?.toUpperCase()) {
    case "GREEN":
      return { label: "High", className: "bg-success-subtle text-success" };
    case "YELLOW":
      return { label: "Medium", className: "bg-warning-subtle text-warning-strong" };
    case "RED":
      return { label: "Low", className: "bg-danger-subtle text-danger" };
    case "UNKNOWN":
    case undefined:
      return null;
    default:
      return { label: quality!, className: "bg-muted text-muted-foreground" };
  }
}

/**
 * Meta's messaging limit tier in words: how many different customers the
 * business can start conversations with in a rolling 24 hours.
 */
export function messagingLimitLabel(tier: string | null): string | null {
  if (!tier) return null;
  const match = /^TIER_(\d+)(K)?$/i.exec(tier);
  if (match) {
    const n = Number(match[1]) * (match[2] ? 1000 : 1);
    return `${n.toLocaleString("en-IN")} customers a day`;
  }
  if (/UNLIMITED/i.test(tier)) return "Unlimited";
  return tier;
}

/** The coexistence chat-history import, in a sentence the merchant can act on. */
export function historySyncLabel(sync: ChannelMessagingStatus["historySync"]): {
  label: string;
  tone: "neutral" | "progress" | "done" | "problem";
} | null {
  if (!sync) return null;
  switch (sync.status) {
    case "pending":
    case "requested":
      return { label: "Waiting for WhatsApp to send your chat history", tone: "progress" };
    case "importing":
      return {
        label: `Importing chat history${sync.progress != null ? ` — ${sync.progress}%` : ""}`,
        tone: "progress",
      };
    case "complete":
      return {
        label: `Chat history imported${sync.messagesReceived ? ` (${sync.messagesReceived.toLocaleString("en-IN")} messages)` : ""}`,
        tone: "done",
      };
    case "declined":
      return { label: "History sharing was turned off on the phone, so past chats were not imported", tone: "neutral" };
    case "expired":
    case "failed":
      return { label: sync.error ?? "Chat history could not be imported", tone: "problem" };
    default:
      return { label: sync.status, tone: "neutral" };
  }
}

export function coexistenceLabel(coexistence: ChannelMessagingStatus["coexistence"]): string | null {
  if (!coexistence) return null;
  if (coexistence.state === "reconnecting") return "Reconnecting after a device change — sending is paused";
  if (coexistence.state === "disconnected") return "Disconnected from the WhatsApp Business app";
  return "Linked to the WhatsApp Business app";
}
