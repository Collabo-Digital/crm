import { ArrowLeft, Check, ChevronDown, Clock, PanelRight, RotateCcw, UserPlus, Users } from "lucide-react";

import { ChannelBadge } from "~/components/app/channel-badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { PRESENCE_DOT, PRESENCE_LABEL, formatDateTime } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { InboxConversationDetail, InboxMe, InboxMember, InboxTeamRef } from "~/types/api";

import { ConversationAvatar } from "./conversation-avatar";
import { ReplyWindowPill } from "./reply-window";
import { SNOOZE_PRESETS } from "./snooze-presets";

const NONE = "none";

/** Column 2 header — identity, reply window, and the status actions. */
export function ThreadHeader({
  conversation,
  members,
  teams,
  me,
  isPanelOpen,
  isMutating,
  onTogglePanel,
  onBack,
  onAssign,
  onTeam,
  onSnooze,
  onClose,
  onReopen,
}: {
  conversation: InboxConversationDetail;
  members: InboxMember[];
  teams: InboxTeamRef[];
  me?: InboxMe;
  isPanelOpen: boolean;
  isMutating: boolean;
  onTogglePanel: () => void;
  onBack: () => void;
  onAssign: (userId: string | null) => void;
  onTeam: (teamId: string | null) => void;
  onSnooze: (until: string, label: string) => void;
  onClose: () => void;
  onReopen: () => void;
}) {
  const { contact, assignee, team, channel, status } = conversation;
  const canReply = conversation.reply.canReply;
  const canAssignOthers = me?.access.canAssignOthers ?? false;
  // Without chat.assign: take a free conversation, or give back your own.
  const assignable = canAssignOthers ? members : members.filter((m) => m.id === me?.userId);
  const assigneePresence = assignee ? members.find((m) => m.id === assignee.id)?.presence : undefined;
  const isClosed = status === "CLOSED";

  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border/60 bg-card px-3 pt-[max(.75rem,env(safe-area-inset-top))] pb-2 md:px-4 md:py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
        {/* Mobile only — the list and the thread share one column below md. */}
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to conversations" className="size-11 rounded-full md:hidden">
          <ArrowLeft className="size-5" />
        </Button>

        <button type="button" onClick={onTogglePanel} aria-label={`Show contact details for ${contact.name}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ConversationAvatar name={contact.name} avatarUrl={contact.avatarUrl} className="max-md:[&_[data-slot=avatar]]:size-11" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground md:text-body">{contact.name}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground md:text-micro">
              <ChannelBadge platform={channel.platform} size={11} className="md:hidden" />
              <ChannelBadge platform={channel.platform} name={channel.name} size={11} className="hidden md:inline-flex" />
              {contact.phone && <span className="hidden sm:inline">{contact.phone}</span>}
              {!contact.phone && contact.username && <span>@{contact.username}</span>}
              <ReplyWindowPill platform={conversation.platform} window={conversation.window} />
              {status === "SNOOZED" && conversation.snoozedUntil && (
                <span className="text-info">Snoozed until {formatDateTime(conversation.snoozedUntil)}</span>
              )}
            </div>
          </div>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onTogglePanel}
          aria-pressed={isPanelOpen}
          aria-label={isPanelOpen ? "Hide contact details" : "Show contact details"}
          title={isPanelOpen ? "Hide details" : "Show details"}
          className={cn("size-11 rounded-full md:hidden", isPanelOpen && "bg-muted")}
        >
          <PanelRight className="size-5" />
        </Button>
      </div>

      <div className="flex w-full shrink-0 items-center gap-1.5 rounded-2xl bg-muted/50 px-1 md:w-auto md:rounded-none md:bg-transparent md:px-0 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11 max-md:[&_button]:rounded-xl">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={isMutating || !canReply} aria-label="Assign conversation" className="max-md:min-w-0 max-md:flex-1 max-md:justify-start">
              {assignee ? (
                <span className="relative">
                  <ConversationAvatar name={assignee.name} avatarUrl={assignee.avatarUrl} size="sm" />
                  {assigneePresence && (
                    <span
                      className={cn("absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-card", PRESENCE_DOT[assigneePresence])}
                    />
                  )}
                </span>
              ) : (
                <UserPlus className="size-3.5 text-muted-foreground" />
              )}
              <span className="min-w-0 max-w-24 truncate text-xs md:hidden lg:inline lg:max-w-28">{assignee?.name ?? "Assign"}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
            <DropdownMenuLabel>Assign to</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={assignee?.id ?? NONE}
              onValueChange={(value) => onAssign(value === NONE ? null : value)}
            >
              <DropdownMenuRadioItem value={NONE}>Unassigned</DropdownMenuRadioItem>
              {assignable.map((member) => (
                <DropdownMenuRadioItem key={member.id} value={member.id}>
                  <span className={cn("size-2 shrink-0 rounded-full", PRESENCE_DOT[member.presence])} />
                  <span className="flex-1 truncate">{member.id === me?.userId ? `${member.name} (you)` : member.name}</span>
                  <span className="text-micro text-muted-foreground">{PRESENCE_LABEL[member.presence]}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {(teams.length > 0 || team) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={isMutating || !canAssignOthers}
                aria-label="Conversation team"
                title={canAssignOthers ? "Team" : "Only members who can assign may change the team"}
              >
                <Users className="size-3.5 text-muted-foreground" />
                <span className="hidden max-w-24 truncate xl:inline">{team?.name ?? "No team"}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Team</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={team?.id ?? NONE} onValueChange={(value) => onTeam(value === NONE ? null : value)}>
                <DropdownMenuRadioItem value={NONE}>No team</DropdownMenuRadioItem>
                {teams.map((t) => (
                  <DropdownMenuRadioItem key={t.id} value={t.id}>
                    {t.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {!isClosed && canReply && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={isMutating} aria-label="Snooze conversation" title="Snooze">
                <Clock className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {SNOOZE_PRESETS.map((preset) => (
                <DropdownMenuItem key={preset.label} onSelect={() => onSnooze(preset.resolve().toISOString(), preset.label)}>
                  {preset.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {canReply &&
          (isClosed || status === "SNOOZED" ? (
            <Button variant="ghost" size="sm" onClick={onReopen} disabled={isMutating} className="max-md:ml-auto">
              <RotateCcw className="size-3.5" />
              Reopen
            </Button>
          ) : (
            <Button variant="accent" size="sm" onClick={onClose} disabled={isMutating} className="max-md:ml-auto">
              <Check className="size-3.5" />
              Close
            </Button>
          ))}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onTogglePanel}
          aria-pressed={isPanelOpen}
          aria-label={isPanelOpen ? "Hide contact details" : "Show contact details"}
          title={isPanelOpen ? "Hide details" : "Show details"}
          className={cn("hidden md:inline-flex", isPanelOpen && "bg-muted")}
        >
          <PanelRight className="size-4" />
        </Button>
      </div>
    </header>
  );
}
