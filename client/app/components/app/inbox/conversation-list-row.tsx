import { memo } from "react";
import { MessageCircle } from "lucide-react";

import { Checkbox } from "~/components/ui/checkbox";
import { StatusBadge } from "~/components/ui/status-badge";
import { formatRowTime } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { InboxConversation } from "~/types/api";

import { ConversationAvatar } from "./conversation-avatar";
import { TagChip } from "./tag-chip";

/**
 * One row in the conversation list.
 *
 * Memoised because the list re-renders on every keystroke in the search box and
 * on every refetch; the rows that did not change should not re-render with it.
 *
 * `now` is passed in rather than read here so all rows date-stamp against one
 * instant — otherwise two rows a millisecond apart can straddle a minute
 * boundary and read "1m" and "2m" for the same message.
 */
export const ConversationListRow = memo(function ConversationListRow({
  conversation,
  isSelected,
  isChecked,
  selecting,
  showOwner,
  now,
  onSelect,
  onCheck,
}: {
  conversation: InboxConversation;
  isSelected: boolean;
  isChecked: boolean;
  /** Bulk-select mode: the checkbox shows on every row. */
  selecting: boolean;
  /** Who has it. Off where the folder already says (Mine, Unassigned). */
  showOwner: boolean;
  now: number;
  onSelect: (id: string) => void;
  onCheck: (id: string, checked: boolean) => void;
}) {
  const { contact, unreadCount, assignee, team, platform } = conversation;
  const unread = unreadCount > 0;
  const awaiting = !!conversation.awaitingReplySince && conversation.status === "OPEN";
  const owner = [assignee?.name ?? (team ? null : "Unassigned"), team?.name].filter(Boolean).join(" · ");
  // A third line only when there is something to say on it.
  const hasMeta = contact.blocked || contact.optedOut || contact.tags.length > 0 || (awaiting && !unread);

  return (
    <div
      className={cn(
        // Flat fill for the selected row rather than an accent rule down the
        // side: at list density a coloured bar reads as a second, competing
        // divider between every pair of rows.
        "group relative flex w-full items-start gap-3.5 px-4 py-3 text-left transition-colors active:bg-muted/70 md:gap-3 md:px-3 md:py-2.5",
        isSelected ? "bg-muted" : "hover:bg-muted/50",
        isChecked && "bg-brand/10",
      )}
    >
      <div className="relative shrink-0">
        {/* The checkbox takes the avatar's place on hover or while selecting. */}
        <div className={cn(selecting ? "hidden" : "md:group-hover:hidden")}>
          <ConversationAvatar name={contact.name} avatarUrl={contact.avatarUrl} platform={platform} isGroup={contact.isGroup} className="max-md:[&_[data-slot=avatar]]:size-12 max-md:[&_[data-slot=avatar-fallback]]:text-base" />
        </div>
        <div className={cn("relative z-10 size-12 items-center justify-center md:size-8", selecting ? "flex" : "hidden md:group-hover:flex")}>
          <Checkbox
            checked={isChecked}
            onCheckedChange={(value) => onCheck(conversation.id, value === true)}
            aria-label={`Select conversation with ${contact.name}`}
          />
        </div>
      </div>

      {/* The whole row opens the thread; the checkbox above sits outside this button. */}
      <button
        type="button"
        onClick={() => (selecting ? onCheck(conversation.id, !isChecked) : onSelect(conversation.id))}
        aria-current={isSelected ? "true" : undefined}
        className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
      >
        <div className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[15px] font-medium text-foreground md:text-caption md:font-normal", unread && "font-semibold md:font-semibold")}>
            {contact.name}
            {/* The badge below is hidden from screen readers; say the count here. */}
            {unread && <span className="sr-only">, {unreadCount} unread</span>}
          </span>
          {showOwner && owner && <span className="max-w-[45%] truncate text-micro text-muted-foreground">{owner}</span>}
          <span className="shrink-0 text-micro text-muted-foreground">
            {formatRowTime(conversation.lastMessageAt, now)}
          </span>
        </div>

        <div className="mt-1 flex items-center gap-2 md:mt-0.5">
          <p className={cn("flex min-w-0 flex-1 items-center gap-1 truncate text-sm md:text-caption", unread ? "text-foreground" : "text-muted-foreground")}>
            {conversation.lastMessagePreview?.startsWith("Comment") && <MessageCircle className="size-3 shrink-0" />}
            <span className="truncate">{conversation.lastMessagePreview ?? "No messages yet"}</span>
          </p>
          {unread && (
            <span
              className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-unread px-1 text-micro font-semibold text-unread-foreground md:h-4 md:min-w-4"
              aria-hidden
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </div>

        {hasMeta && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {contact.blocked && <StatusBadge tone="critical">Blocked</StatusBadge>}
            {contact.optedOut && !contact.blocked && <StatusBadge tone="attention">Opted out</StatusBadge>}
            {contact.tags.slice(0, 2).map((tag) => (
              <TagChip key={tag} tag={tag} />
            ))}
            {contact.tags.length > 2 && <span className="text-micro text-muted-foreground">+{contact.tags.length - 2}</span>}
            {awaiting && !unread && <span className="text-micro text-warning-strong-text">Waiting for reply</span>}
          </div>
        )}
      </button>
    </div>
  );
});
