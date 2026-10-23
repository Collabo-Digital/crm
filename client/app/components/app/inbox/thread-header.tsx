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
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {/* Mobile only — the list and the thread share one column below md. */}
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to conversations" className="md:hidden">
          <ArrowLeft className="size-4" />
        </Button>

        <ConversationAvatar name={contact.name} avatarUrl={contact.avatarUrl} />

        <div className="min-w-0">
          <p className="truncate text-body font-semibold text-foreground">{contact.name}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-muted-foreground">
            <ChannelBadge platform={channel.platform} name={channel.name} size={11} />
            {contact.phone && <span>{contact.phone}</span>}
            {!contact.phone && contact.username && <span>@{contact.username}</span>}
            <ReplyWindowPill platform={conversation.platform} window={conversation.window} />
            {status === "SNOOZED" && conversation.snoozedUntil && (
              <span className="text-info">Snoozed until {formatDateTime(conversation.snoozedUntil)}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={isMutating || !canReply} aria-label="Assign conversation">
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
              <span className="hidden max-w-28 truncate lg:inline">{assignee?.name ?? "Unassigned"}</span>
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
            <Button variant="ghost" size="sm" onClick={onReopen} disabled={isMutating}>
              <RotateCcw className="size-3.5" />
              Reopen
            </Button>
          ) : (
            <Button variant="accent" size="sm" onClick={onClose} disabled={isMutating}>
              <Check className="size-3.5" />
              Close
            </Button>
          ))}

        {/*
          Hidden below lg: there the panel has no room to become a column, so
          the control would be inert. A dead toggle reads as a bug.
        */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onTogglePanel}
          aria-pressed={isPanelOpen}
          aria-label={isPanelOpen ? "Hide contact details" : "Show contact details"}
          title={isPanelOpen ? "Hide details" : "Show details"}
          className={cn("hidden lg:inline-flex", isPanelOpen && "bg-muted")}
        >
          <PanelRight className="size-4" />
        </Button>
      </div>
    </header>
  );
}
