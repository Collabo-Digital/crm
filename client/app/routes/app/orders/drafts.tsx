import { oneOf, useSessionState } from "~/hooks/use-session-state";
import { useClampPage, useListUrlState } from "~/hooks/use-list-url-state";
import { Link, useNavigate } from "react-router";
import {
  FileText,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MoreHorizontal,
} from "lucide-react";
import { useDraftOrders, useDraftOrderStats } from "~/hooks/use-draft-order-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useDeleteDraftOrderMutation } from "~/hooks/use-draft-order-mutations";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
  PageHeaderDescription,
  PageHeaderActions,
} from "~/components/ui/page-header";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { StatCard } from "~/components/app/stat-card";
import { SectionCard } from "~/components/app/section-card";
import { SegmentedTabs } from "~/components/app/segmented-tabs";
import { EmptyState } from "~/components/app/empty-state";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { QueryErrorState } from "~/components/app/query-error-state";
import { formatCurrency, cn } from "~/lib/utils";
import { DRAFT_STATUS_CLASSES, DRAFT_STATUS_LABELS } from "~/lib/draft-status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";
import type {
  DraftOrder,
  DraftOrderListParams,
  DraftOrderStats,
  DraftOrderStatus,
} from "~/types/api";
import { useDebounced } from "~/hooks/use-debounced";

export function meta() {
  return [{ title: "Drafts | Collabo CRM" }];
}

const PAGE_SIZE = 15;

type Chip = DraftOrderStatus | "all";

/** "1 – 24 Aug 2026" — the window the month-to-date figures cover. */
function formatStatsWindow(stats: DraftOrderStats): string {
  const start = new Date(stats.periodStart);
  const end = new Date(stats.periodEnd);
  const endLabel = end.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${start.getDate()} – ${endLabel}`;
}

export default function DraftsPage() {
  const navigate = useNavigate();
  const { data: org } = useCurrentOrg();

  // Page and search live in the URL so Back from a draft (and the draft
  // page's breadcrumb) return to the page the row was opened from.
  const list = useListUrlState("drafts");
  const [status, setStatus] = useSessionState<Chip>(
    "drafts.status",
    "all",
    oneOf(["all", "OPEN", "INVOICE_SENT", "COMPLETED"]),
  );

  // Debounced into the query key only — the input keeps the raw value, so
  // typing stays instant without a request per keystroke.
  const debouncedSearch = useDebounced(list.search, 350);

  const params: DraftOrderListParams = {
    page: list.page,
    limit: PAGE_SIZE,
    search: debouncedSearch || undefined,
    status: status === "all" ? undefined : status,
  };

  const { data, isLoading, isError, refetch } = useDraftOrders(params);
  const { data: stats, isLoading: statsLoading } = useDraftOrderStats();
  const deleteDraft = useDeleteDraftOrderMutation();

  // The stats endpoint reports the workspace currency; fall back to the org
  // record while it is in flight so the KPI row does not flip currency on load.
  const currency = stats?.currency ?? org?.currency ?? "INR";

  const drafts = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;
  useClampPage(list, meta?.totalPages);

  function handleChip(next: Chip) {
    setStatus(next);
    list.resetPage();
  }

  function handleSearch(event: React.ChangeEvent<HTMLInputElement>) {
    list.setSearch(event.target.value);
  }

  const isFiltered = Boolean(list.search) || status !== "all";

  return (
    <div className="space-y-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Drafts</PageHeaderTitle>
          <PageHeaderDescription>
            In-progress orders and quotes. Edit them anytime, then complete to
            convert into a finalized order.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button asChild variant="brand" size="action">
            <Link to="/orders/drafts/new">
              <Plus className="size-3.5" />
              New draft
            </Link>
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {/* KPI row. Org-wide, not page-derived — these figures must not move
          when the user pages through the table below. */}
      <div className="grid grid-cols-1 gap-5 rounded-xl bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
        {statsLoading || !stats ? (
          Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="p-5">
              <Skeleton className="mb-4 h-3 w-24" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : (
          [
            {
              key: "open",
              label: "Open drafts",
              value: stats.counts.open.toLocaleString("en-IN"),
              // No `change`: an open-draft count is a running balance, not a
              // monthly flow, and nothing records what it was a month ago.
              changeLabel: `${stats.invoiceSent.count} awaiting payment`,
            },
            {
              key: "value",
              label: "Open draft value",
              value: formatCurrency(stats.openDrafts.value, currency, {
                maximumFractionDigits: 0,
              }),
              changeLabel: "Open + invoice sent",
            },
            {
              key: "converted",
              label: "Converted this month",
              value: stats.convertedThisMonth.count.toLocaleString("en-IN"),
              change: stats.convertedThisMonth.changePct ?? undefined,
              changeLabel: formatStatsWindow(stats),
            },
            {
              key: "converted-value",
              label: "Converted value",
              value: formatCurrency(stats.convertedThisMonth.value, currency, {
                maximumFractionDigits: 0,
              }),
              change: stats.convertedThisMonth.valueChangePct ?? undefined,
              changeLabel: "Now finalized orders",
            },
          ].map((card, index, all) => (
            <div key={card.key} className="flex items-center gap-4">
              <StatCard
                variant="inline"
                label={card.label}
                value={card.value}
                change={card.change}
                changeLabel={card.changeLabel}
                className="flex-1"
              />
              {index < all.length - 1 && (
                <Separator orientation="vertical" className="hidden h-15 md:block" />
              )}
            </div>
          ))
        )}
      </div>

      {/* Filters */}
      <SegmentedTabs
        items={[
          { value: "all", label: "All", count: stats?.counts.all },
          { value: "OPEN", label: "Open", count: stats?.counts.open },
          {
            value: "INVOICE_SENT",
            label: "Invoice sent",
            count: stats?.counts.invoiceSent,
          },
          {
            value: "COMPLETED",
            label: "Completed",
            count: stats?.counts.completed,
          },
        ]}
        value={status}
        onChange={handleChip}
        ariaLabel="Filter drafts"
        behaviour="filter"
      />

      <SectionCard
        title="All drafts"
        description="Every in-progress order and quote in this workspace."
        action={
          <div className="relative min-w-50 max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Customer name or email…"
              value={list.search}
              onChange={handleSearch}
              className="h-8 w-full rounded-lg border border-input bg-transparent pl-8 pr-3 text-caption placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
          </div>
        }
      >
        {/* The error branch MUST precede loading and empty. A failed request
            leaves isLoading false and data undefined, so `drafts.length === 0`
            was reached and the user was told they had no drafts at all.
            `!data` keeps a failed background refetch from blanking a table that
            is already on screen. */}
        {isError && !data ? (
          <div className="p-8">
            <QueryErrorState resource="drafts" onRetry={() => refetch()} />
          </div>
        ) : isLoading ? (
          <div className="p-4">
            <TableSkeleton rows={PAGE_SIZE} columns={7} />
          </div>
        ) : drafts.length === 0 ? (
          <div className="p-8">
            <EmptyState
              icon={FileText}
              title="No drafts found"
              description={
                isFiltered
                  ? "Try adjusting your search or filters."
                  : "Save an order as a draft from the order create page, or start a fresh one from here."
              }
              action={
                isFiltered ? undefined : (
                  <Button asChild variant="brand" size="sm">
                    <Link to="/orders/drafts/new">
                      <Plus className="size-3.5" />
                      Create draft
                    </Link>
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Draft</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-10">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drafts.map((d) => (
                  <DraftRow
                    key={d.id}
                    draft={d}
                    currency={currency}
                    onOpen={() => navigate(`/orders/drafts/${d.id}`)}
                    onDelete={() => deleteDraft.mutate(d.id)}
                    deleting={deleteDraft.isPending && deleteDraft.variables === d.id}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!isLoading && drafts.length > 0 && (
          <div className="flex items-center justify-between border-t px-5 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => list.setPage(list.page - 1)}
              disabled={list.page === 1}
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
            <p className="text-caption text-muted-foreground">
              Page {meta?.page ?? 1} of {totalPages} ({meta?.total ?? 0} total)
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => list.setPage(list.page + 1)}
              disabled={list.page >= totalPages}
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function DraftRow({
  draft,
  currency,
  onOpen,
  onDelete,
  deleting,
}: {
  draft: DraftOrder;
  currency: string;
  onOpen: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const customerName = draft.customer
    ? `${draft.customer.firstName ?? ""} ${draft.customer.lastName ?? ""}`.trim() ||
      draft.customer.email ||
      "Unnamed"
    : draft.customerEmail ?? "Anonymous";
  const isCompleted = draft.status === "COMPLETED";

  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="font-medium text-foreground">
        {draft.name ?? `Draft ${draft.id.slice(-6)}`}
      </TableCell>
      <TableCell className="text-body">
        {draft.customer ? (
          customerName
        ) : (
          <span className="text-muted-foreground italic">{customerName}</span>
        )}
      </TableCell>
      <TableCell className="text-body text-muted-foreground">
        {draft.itemCount} item{draft.itemCount !== 1 ? "s" : ""}
      </TableCell>
      <TableCell className="text-body font-medium tabular-nums">
        {formatCurrency(draft.totalPrice, currency)}
      </TableCell>
      <TableCell>
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-micro font-medium",
            DRAFT_STATUS_CLASSES[draft.status],
          )}
        >
          {DRAFT_STATUS_LABELS[draft.status]}
        </span>
      </TableCell>
      <TableCell className="text-caption text-muted-foreground">
        {new Date(draft.updatedAt).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })}
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={deleting}>
              {deleting ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <MoreHorizontal className="size-4 text-muted-foreground" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}>
              {isCompleted ? "View" : "Open"}
            </DropdownMenuItem>
            {!isCompleted && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
