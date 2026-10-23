import { Bookmark, Check, ChevronDown, Inbox, Trash2, User, Users, UserX } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";
import type { InboxCounts, InboxListStatus, InboxListView, InboxSavedView, InboxTeamRef } from "~/types/api";

const VIEWS: Array<{ view: InboxListView; label: string; icon: typeof Inbox; count: keyof InboxCounts }> = [
  { view: "all", label: "All conversations", icon: Inbox, count: "all" },
  { view: "mine", label: "Assigned to me", icon: User, count: "mine" },
  { view: "unassigned", label: "Unassigned", icon: UserX, count: "unassigned" },
];

const STATUSES: Array<{ status: InboxListStatus; label: string }> = [
  { status: "open", label: "Open" },
  { status: "snoozed", label: "Snoozed" },
  { status: "closed", label: "Closed" },
];

/** What the folder trigger says: the saved view's name, a team, or the view. */
export function folderLabel(state: {
  savedView?: InboxSavedView;
  team?: InboxTeamRef;
  view: InboxListView;
  status: InboxListStatus;
}): string {
  const base = state.savedView?.name ?? state.team?.name ?? VIEWS.find((v) => v.view === state.view)!.label;
  return state.status === "open" || state.savedView ? base : `${base} · ${STATUSES.find((s) => s.status === state.status)?.label}`;
}

/**
 * Which conversations the list holds: a built-in view, a team's queue, or a
 * saved view — plus open, snoozed or closed. One menu, because these are the
 * same kind of decision ("whose work am I looking at") and a rail of links
 * would spend permanent width on something set once per session.
 *
 * Counts come from /inbox/counts, so they describe the whole inbox and do not
 * collapse to the visible row count while a filter is active.
 */
export function InboxFolderMenu({
  counts,
  view,
  status,
  teamId,
  teams,
  savedViews,
  activeViewId,
  label,
  onView,
  onStatus,
  onTeam,
  onSavedView,
  onSaveCurrent,
  onDeleteView,
}: {
  counts?: InboxCounts;
  view: InboxListView;
  status: InboxListStatus;
  teamId: string | null;
  teams: InboxTeamRef[];
  savedViews: InboxSavedView[];
  activeViewId: string | null;
  label: string;
  onView: (view: InboxListView) => void;
  onStatus: (status: InboxListStatus) => void;
  onTeam: (teamId: string) => void;
  onSavedView: (view: InboxSavedView) => void;
  onSaveCurrent: () => void;
  onDeleteView: (view: InboxSavedView) => void;
}) {
  const builtIn = !teamId && !activeViewId;
  const activeCount = activeViewId
    ? counts?.views[activeViewId]
    : teamId
      ? counts?.teams[teamId]
      : status === "open"
        ? (counts?.[VIEWS.find((v) => v.view === view)!.count] as number | undefined)
        : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-1 min-w-0 gap-1.5 px-1.5">
          <span className="truncate text-caption font-semibold text-foreground">{label}</span>
          {!!activeCount && <span className="text-caption tabular-nums text-muted-foreground">{activeCount}</span>}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Inbox</DropdownMenuLabel>
        {VIEWS.map((item) => {
          const active = builtIn && item.view === view;
          const count = counts?.[item.count] as number | undefined;
          return (
            <DropdownMenuItem key={item.view} onSelect={() => onView(item.view)} className={cn(active && "bg-muted")}>
              <item.icon className="size-3.5 text-muted-foreground" />
              <span className="flex-1">{item.label}</span>
              {!!count && <span className="text-caption tabular-nums text-muted-foreground">{count}</span>}
            </DropdownMenuItem>
          );
        })}

        {!activeViewId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Status</DropdownMenuLabel>
            {STATUSES.map((item) => (
              <DropdownMenuItem key={item.status} onSelect={() => onStatus(item.status)}>
                <Check className={cn("size-3.5", item.status === status ? "opacity-100" : "opacity-0")} />
                <span className="flex-1">{item.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        {teams.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Teams</DropdownMenuLabel>
            {teams.map((team) => (
              <DropdownMenuItem
                key={team.id}
                onSelect={() => onTeam(team.id)}
                className={cn(team.id === teamId && !activeViewId && "bg-muted")}
              >
                <Users className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{team.name}</span>
                {!!counts?.teams[team.id] && (
                  <span className="text-caption tabular-nums text-muted-foreground">{counts.teams[team.id]}</span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Saved views</DropdownMenuLabel>
        {savedViews.map((saved) => (
          <DropdownMenuItem
            key={saved.id}
            onSelect={() => onSavedView(saved)}
            className={cn("group/view", saved.id === activeViewId && "bg-muted")}
          >
            <Bookmark className="size-3.5 text-muted-foreground" />
            <span className="flex-1 truncate">{saved.name}</span>
            {!!counts?.views[saved.id] && (
              <span className="text-caption tabular-nums text-muted-foreground group-hover/view:hidden">
                {counts.views[saved.id]}
              </span>
            )}
            {saved.canEdit && (
              <button
                type="button"
                onClick={(event) => {
                  // Deleting must not also open the view.
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteView(saved);
                }}
                className="hidden rounded p-0.5 text-muted-foreground hover:text-danger group-hover/view:block"
                aria-label={`Delete view ${saved.name}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={onSaveCurrent} className="text-muted-foreground">
          <Bookmark className="size-3.5" />
          Save current filters as a view…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
