import { CheckSquare, Search, X } from "lucide-react";

import { CHANNEL_LABEL } from "~/components/app/channel-badge";
import { QueryErrorState } from "~/components/app/query-error-state";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useNow } from "~/hooks/use-now";
import { cn } from "~/lib/utils";
import type {
  Channel,
  InboxBulkRequest,
  InboxConversation,
  InboxCounts,
  InboxFilters,
  InboxMember,
  InboxSavedView,
  InboxTeamRef,
} from "~/types/api";

import { BulkActionBar } from "./bulk-action-bar";
import { ConversationListRow } from "./conversation-list-row";
import { ConversationListSkeleton } from "./conversation-skeletons";
import { InboxFilterMenu } from "./inbox-filter-menu";
import { InboxFolderMenu, folderLabel } from "./inbox-folder-menu";

/** A removable chip for one active narrowing filter. */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="inline-flex min-h-9 w-fit items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-0 md:gap-1 md:px-2 md:py-0.5 md:text-micro"
    >
      {label}
      <X className="size-3" />
      <span className="sr-only">Clear filter</span>
    </button>
  );
}

/**
 * Column 1 — search, folder, filters, bulk actions and the rows.
 *
 * Placeholder data dims the list instead of swapping it for a skeleton: the
 * previous folder's rows stay mounted during a refetch, so a skeleton here
 * would throw away the very continuity that setting exists to buy.
 */
export function ConversationList({
  conversations,
  counts,
  filters,
  activeViewId,
  teams,
  savedViews,
  members,
  channels,
  meId,
  canAssignOthers,
  seesOthers,
  selectedId,
  checkedIds,
  selecting,
  isLoading,
  isPlaceholder,
  isError,
  hasMore,
  isLoadingMore,
  isBulkPending,
  onLoadMore,
  onRetry,
  onFiltersChange,
  onSavedView,
  onSaveView,
  onDeleteView,
  onSelect,
  onCheck,
  onToggleSelecting,
  onBulk,
  className,
}: {
  conversations: InboxConversation[];
  counts?: InboxCounts;
  filters: InboxFilters;
  activeViewId: string | null;
  teams: InboxTeamRef[];
  savedViews: InboxSavedView[];
  members: InboxMember[];
  channels: Channel[];
  meId: string | undefined;
  canAssignOthers: boolean;
  seesOthers: boolean;
  selectedId: string | null;
  checkedIds: Set<string>;
  selecting: boolean;
  isLoading: boolean;
  isPlaceholder: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  isBulkPending: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  /** Patch the filters; a patch always leaves any saved view. */
  onFiltersChange: (patch: Partial<InboxFilters>, replace?: boolean) => void;
  onSavedView: (view: InboxSavedView) => void;
  onSaveView: () => void;
  onDeleteView: (view: InboxSavedView) => void;
  onSelect: (id: string) => void;
  onCheck: (id: string, checked: boolean) => void;
  onToggleSelecting: () => void;
  onBulk: (action: Omit<InboxBulkRequest, "ids">) => void;
  className?: string;
}) {
  // Owned here, not passed down: every row must date-stamp against the same
  // instant, and the tick must not re-render the thread or the panel.
  const now = useNow(60_000);

  const view = filters.view ?? "all";
  const status = filters.status ?? "open";
  const team = teams.find((t) => t.id === filters.teamId);
  const savedView = savedViews.find((v) => v.id === activeViewId);
  const channel = channels.find((c) => c.id === filters.channelId);
  const assignee = members.find((m) => m.id === filters.assigneeId);
  const knownTags = [...new Set([...conversations.flatMap((c) => c.contact.tags), ...(filters.tag ? [filters.tag] : [])])].sort();

  const chips = [
    filters.unread && { key: "unread", label: "Unread", clear: { unread: undefined } },
    filters.comments && { key: "comments", label: "Comments", clear: { comments: undefined } },
    channel && { key: "channel", label: channel.name || CHANNEL_LABEL[channel.platform], clear: { channelId: undefined } },
    filters.tag && { key: "tag", label: `#${filters.tag}`, clear: { tag: undefined } },
    assignee && { key: "assignee", label: assignee.name, clear: { assigneeId: undefined } },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: Partial<InboxFilters> }>;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="shrink-0 space-y-2.5 border-b border-border/60 px-4 pt-4 pb-2 md:px-3 md:py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground md:left-2.5 md:size-3.5" />
          <Input
            type="search"
            value={filters.search ?? ""}
            onChange={(event) => onFiltersChange({ search: event.target.value || undefined })}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="h-12 rounded-2xl border-transparent bg-muted/70 pl-11 text-base shadow-none md:h-9 md:rounded-md md:border-input md:bg-transparent md:pl-8 md:text-caption"
          />
        </div>

        {checkedIds.size > 0 ? (
          <BulkActionBar
            count={checkedIds.size}
            members={members}
            teams={teams}
            canAssignOthers={canAssignOthers}
            meId={meId}
            isPending={isBulkPending}
            onAction={onBulk}
            onClear={onToggleSelecting}
          />
        ) : (
          <div className="flex items-center justify-between gap-2 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11 max-md:[&_button]:rounded-xl">
            <InboxFolderMenu
              counts={counts}
              view={view}
              status={status}
              teamId={filters.teamId ?? null}
              teams={teams}
              savedViews={savedViews}
              activeViewId={activeViewId}
              label={folderLabel({ savedView, team, view, status })}
              onView={(next) => onFiltersChange({ view: next, teamId: undefined }, true)}
              onStatus={(next) => onFiltersChange({ status: next })}
              onTeam={(teamId) => onFiltersChange({ view: "all", teamId }, true)}
              onSavedView={onSavedView}
              onSaveCurrent={onSaveView}
              onDeleteView={onDeleteView}
            />
            <div className="flex shrink-0 items-center">
              <InboxFilterMenu
                filters={filters}
                channels={channels}
                tags={knownTags}
                members={members}
                showAssignee={seesOthers}
                onChange={(patch) => onFiltersChange(patch)}
              />
              <Button
                variant={selecting ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={onToggleSelecting}
                aria-pressed={selecting}
                aria-label="Select conversations"
                title="Select"
              >
                <CheckSquare />
              </Button>
            </div>
          </div>
        )}

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <FilterChip key={chip.key} label={chip.label} onClear={() => onFiltersChange(chip.clear)} />
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 md:pb-0">
        {isError ? (
          <div className="p-4">
            <QueryErrorState resource="conversations" onRetry={onRetry} />
          </div>
        ) : isLoading ? (
          <ConversationListSkeleton />
        ) : conversations.length === 0 ? (
          <p className="p-6 text-center text-caption text-muted-foreground">
            {filters.search ? `No conversations match “${filters.search}”.` : "Nothing here right now."}
          </p>
        ) : (
          <div
            className={cn(
              // A hairline, not a full-weight divider: enough rhythm to keep
              // sixteen rows from bleeding together, light enough that the
              // selected row's fill is still the loudest thing in the column.
              "flex flex-col divide-y divide-border/60 transition-opacity",
              isPlaceholder && "opacity-60",
            )}
          >
            {conversations.map((conversation) => (
              <ConversationListRow
                key={conversation.id}
                conversation={conversation}
                isSelected={conversation.id === selectedId}
                isChecked={checkedIds.has(conversation.id)}
                selecting={selecting}
                now={now}
                onSelect={onSelect}
                onCheck={onCheck}
              />
            ))}
            {hasMore && (
              <div className="p-3">
                <Button variant="ghost" size="sm" className="w-full" onClick={onLoadMore} disabled={isLoadingMore}>
                  {isLoadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
