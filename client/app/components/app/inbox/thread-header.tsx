import { ArrowLeft, Check, ChevronDown, Clock, EllipsisVertical, PanelRight, RotateCcw, UserPlus, UserRound, Users } from "lucide-react";

import { CallButton } from "~/components/app/calls/call-button";
import { CHANNEL_ICON, ChannelBadge } from "~/components/app/channel-badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { PRESENCE_DOT, PRESENCE_LABEL, formatDateTime } from "~/lib/inbox-format";
import { cn } from "~/lib/utils";
import type { InboxConversationDetail, InboxMe, InboxMember, InboxTeamRef } from "~/types/api";

import { ConversationAvatar } from "./conversation-avatar";
import { ReplyWindowPill } from "./reply-window";
import { SNOOZE_PRESETS } from "./snooze-presets";

const NONE = "none";

/**
 * Column 2 header — identity, reply window, and the status actions.
 *
 * On a phone it is WhatsApp's chat bar: back, picture, name with one line
 * under it, then call and a menu holding assign, team, snooze and close. On
 * a desktop the same actions sit out in the bar.
 */
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
  const canCall = canReply && conversation.platform === "WHATSAPP" && !contact.isGroup && !contact.blockedAt;
  const showTeams = teams.length > 0 || !!team;
  const ChannelIcon = CHANNEL_ICON[channel.platform];

  const assignItems = (
    <DropdownMenuRadioGroup value={assignee?.id ?? NONE} onValueChange={(value) => onAssign(value === NONE ? null : value)}>
      <DropdownMenuRadioItem value={NONE}>Unassigned</DropdownMenuRadioItem>
      {assignable.map((member) => (
        <DropdownMenuRadioItem key={member.id} value={member.id}>
          <span className={cn("size-2 shrink-0 rounded-full", PRESENCE_DOT[member.presence])} />
          <span className="flex-1 truncate">{member.id === me?.userId ? `${member.name} (you)` : member.name}</span>
          <span className="text-micro text-muted-foreground">{PRESENCE_LABEL[member.presence]}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
  const teamItems = (
    <DropdownMenuRadioGroup value={team?.id ?? NONE} onValueChange={(value) => onTeam(value === NONE ? null : value)}>
      <DropdownMenuRadioItem value={NONE}>No team</DropdownMenuRadioItem>
      {teams.map((t) => (
        <DropdownMenuRadioItem key={t.id} value={t.id}>
          {t.name}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
  const snoozeItems = SNOOZE_PRESETS.map((preset) => (
    <DropdownMenuItem key={preset.label} onSelect={() => onSnooze(preset.resolve().toISOString(), preset.label)}>
      {preset.label}
    </DropdownMenuItem>
  ));
  const iconButton = "text-chat-icon hover:bg-black/5 dark:hover:bg-white/10";

  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-chat-divider bg-chat-bar px-1 pt-[max(.375rem,env(safe-area-inset-top))] pb-1.5 md:gap-3 md:px-4 md:py-2.5">
      {/* Mobile only — the list and the thread share one column below md. */}
      <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to conversations" className={cn("size-11 shrink-0 rounded-full md:hidden", iconButton)}>
        <ArrowLeft className="size-5" />
      </Button>

      <button
        type="button"
        onClick={onTogglePanel}
        aria-label={`Show contact details for ${contact.name}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ConversationAvatar name={contact.name} avatarUrl={contact.avatarUrl} isGroup={contact.isGroup} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-medium leading-5 text-foreground md:text-body md:font-semibold">{contact.name}</p>
          <div className="mt-0.5 flex min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap text-[12.5px] leading-4 text-chat-meta md:flex-wrap md:gap-y-0.5 md:text-micro">
            {ChannelIcon && (
              <span className="shrink-0 md:hidden" title={channel.name}>
                <ChannelIcon width={12} height={12} />
              </span>
            )}
            <ChannelBadge platform={channel.platform} name={channel.name} size={11} className="hidden md:inline-flex" />
            {contact.phone && <span className="hidden xl:inline">{contact.phone}</span>}
            {!contact.phone && contact.username && <span className="hidden truncate sm:inline">@{contact.username}</span>}
            <ReplyWindowPill platform={conversation.platform} window={conversation.window} className="min-w-0 truncate" />
            {status === "SNOOZED" && conversation.snoozedUntil && (
              <span className="hidden text-info md:inline">Snoozed until {formatDateTime(conversation.snoozedUntil)}</span>
            )}
          </div>
        </div>
      </button>

      {/* Phone: call, then everything else in one menu. */}
      <div className="flex shrink-0 items-center md:hidden">
        {canCall && <CallButton conversationId={conversation.id} name={contact.name} className={cn("size-11 rounded-full [&_svg]:size-5", iconButton)} />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Conversation actions" className={cn("size-11 rounded-full", iconButton)}>
              <EllipsisVertical className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={onTogglePanel}>
              <UserRound />
              Contact details
            </DropdownMenuItem>
            {status === "SNOOZED" && conversation.snoozedUntil && (
              <DropdownMenuLabel className="font-normal text-info">Snoozed until {formatDateTime(conversation.snoozedUntil)}</DropdownMenuLabel>
            )}
            {canReply && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={isMutating}>
                    <UserPlus />
                    <span className="min-w-0 flex-1 truncate">{assignee ? `Assigned to ${assignee.name}` : "Assign"}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">{assignItems}</DropdownMenuSubContent>
                </DropdownMenuSub>
                {showTeams && canAssignOthers && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={isMutating}>
                      <Users />
                      <span className="min-w-0 flex-1 truncate">{team ? `Team: ${team.name}` : "Team"}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>{teamItems}</DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {!isClosed && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={isMutating}>
                      <Clock />
                      Snooze
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>{snoozeItems}</DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSeparator />
                {isClosed || status === "SNOOZED" ? (
                  <DropdownMenuItem onSelect={onReopen} disabled={isMutating}>
                    <RotateCcw />
                    Reopen conversation
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={onClose} disabled={isMutating}>
                    <Check />
                    Close conversation
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Desktop: the actions out in the bar. */}
      <div className="hidden shrink-0 items-center gap-1.5 md:flex">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={isMutating || !canReply} aria-label="Assign conversation" className={iconButton}>
              {assignee ? (
                <span className="relative">
                  <ConversationAvatar name={assignee.name} avatarUrl={assignee.avatarUrl} size="sm" />
                  {assigneePresence && (
                    <span className={cn("absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-chat-bar", PRESENCE_DOT[assigneePresence])} />
                  )}
                </span>
              ) : (
                <UserPlus className="size-3.5" />
              )}
              <span className="hidden min-w-0 truncate text-xs text-foreground lg:inline lg:max-w-28">{assignee?.name ?? "Assign"}</span>
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
            <DropdownMenuLabel>Assign to</DropdownMenuLabel>
            {assignItems}
          </DropdownMenuContent>
        </DropdownMenu>

        {showTeams && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={isMutating || !canAssignOthers}
                aria-label="Conversation team"
                title={canAssignOthers ? "Team" : "Only members who can assign may change the team"}
                className={iconButton}
              >
                <Users className="size-3.5" />
                <span className="hidden max-w-24 truncate text-foreground xl:inline">{team?.name ?? "No team"}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Team</DropdownMenuLabel>
              {teamItems}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {canCall && <CallButton conversationId={conversation.id} name={contact.name} className={iconButton} />}

        {!isClosed && canReply && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={isMutating} aria-label="Snooze conversation" title="Snooze" className={iconButton}>
                <Clock className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {snoozeItems}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {canReply &&
          (isClosed || status === "SNOOZED" ? (
            <Button variant="ghost" size="sm" onClick={onReopen} disabled={isMutating} className={iconButton}>
              <RotateCcw className="size-3.5" />
              Reopen
            </Button>
          ) : (
            <Button variant="accent" size="sm" onClick={onClose} disabled={isMutating}>
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
          className={cn(iconButton, isPanelOpen && "bg-black/5 dark:bg-white/10")}
        >
          <PanelRight className="size-4" />
        </Button>
      </div>
    </header>
  );
}
