import { useState } from "react";
import { CheckCheck, Clock, Tag, UserPlus, Users, X, XCircle } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import type { InboxBulkRequest, InboxMember, InboxTeamRef } from "~/types/api";

import { SNOOZE_PRESETS } from "./snooze-presets";

/**
 * What the list header becomes while conversations are checked. Each action
 * is applied to every checked conversation the member may change; the server
 * reports the rest as skipped rather than failing the batch.
 */
export function BulkActionBar({
  count,
  members,
  teams,
  canAssignOthers,
  meId,
  isPending,
  onAction,
  onClear,
}: {
  count: number;
  members: InboxMember[];
  teams: InboxTeamRef[];
  canAssignOthers: boolean;
  /** Without chat.assign a member may only take conversations for themselves. */
  meId: string | undefined;
  isPending: boolean;
  onAction: (action: Omit<InboxBulkRequest, "ids">) => void;
  onClear: () => void;
}) {
  const [tag, setTag] = useState("");
  const [tagOpen, setTagOpen] = useState(false);

  function applyTag(action: "tag" | "untag") {
    const value = tag.trim();
    if (!value) return;
    onAction({ action, tag: value });
    setTag("");
    setTagOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-caption font-semibold text-foreground tabular-nums">{count} selected</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" disabled={isPending} aria-label="Assign selected" title="Assign">
            <UserPlus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuLabel>Assign to</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onAction({ action: "assign", assignedUserId: null })}>Unassigned</DropdownMenuItem>
          {members
            .filter((m) => canAssignOthers || m.id === meId)
            .map((member) => (
              <DropdownMenuItem key={member.id} onSelect={() => onAction({ action: "assign", assignedUserId: member.id })}>
                {member.name}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {canAssignOthers && teams.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" disabled={isPending} aria-label="Move selected to a team" title="Team">
              <Users />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Move to team</DropdownMenuLabel>
            {teams.map((team) => (
              <DropdownMenuItem key={team.id} onSelect={() => onAction({ action: "team", teamId: team.id })}>
                {team.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAction({ action: "team", teamId: null })}>No team</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" disabled={isPending} aria-label="Snooze selected" title="Snooze">
            <Clock />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
          {SNOOZE_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.label}
              onSelect={() => onAction({ action: "snooze", snoozedUntil: preset.resolve().toISOString() })}
            >
              {preset.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover open={tagOpen} onOpenChange={setTagOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs" disabled={isPending} aria-label="Tag selected" title="Tag">
            <Tag />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 space-y-2 p-3">
          <Input
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyTag("tag");
            }}
            placeholder="Tag name"
            aria-label="Tag name"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="xs" onClick={() => applyTag("untag")} disabled={!tag.trim()}>
              Remove
            </Button>
            <Button variant="accent" size="xs" onClick={() => applyTag("tag")} disabled={!tag.trim()}>
              Add tag
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        variant="ghost"
        size="icon-xs"
        disabled={isPending}
        onClick={() => onAction({ action: "mark_read" })}
        aria-label="Mark selected as read"
        title="Mark as read"
      >
        <CheckCheck />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={isPending}
        onClick={() => onAction({ action: "close" })}
        aria-label="Close selected"
        title="Close"
      >
        <XCircle />
      </Button>

      <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={onClear} aria-label="Clear selection" title="Clear selection">
        <X />
      </Button>
    </div>
  );
}
