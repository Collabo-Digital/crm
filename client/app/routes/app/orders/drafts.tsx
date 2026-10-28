import { useMemo } from "react";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { Link, useNavigate } from "react-router";
import { FileText, Plus, Loader2, MoreHorizontal } from "lucide-react";
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
import { STAT_STRIP, StatCard } from "~/components/app/stat-card";
import {
  DataTable,
  DateCell,
  IdCell,
  MoneyCell,
  StatusPill,
  TextCell,
  useDataTableState,
  type ColumnDef,
} from "~/components/app/data-table";
import { cn, formatCurrency } from "~/lib/utils";
import { DRAFT_STATUS_CLASSES, DRAFT_STATUS_LABELS } from "~/lib/draft-status";
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

export function meta() {
  return [{ title: "Drafts | Collabo CRM" }];
}

type Chip = DraftOrderStatus | "all";
const CHIPS: ReadonlyArray<Chip> = ["all", "OPEN", "INVOICE_SENT", "COMPLETED"];

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

function customerNameOf(draft: DraftOrder): string {
  return draft.customer
    ? `${draft.customer.firstName ?? ""} ${draft.customer.lastName ?? ""}`.trim() ||
        draft.customer.email ||
        "Unnamed"
    : (draft.customerEmail ?? "Anonymous");
}

export default function DraftsPage() {
  const navigate = useNavigate();
  const { data: org } = useCurrentOrg();

  // The whole view — page, search, status tab, sort, page size — lives in the
  // URL so Back from a draft (and the draft page's breadcrumb) return to the
  // exact list the row was opened from.
  const list = useListUrlState("drafts");
  const { data: stats, isLoading: statsLoading } = useDraftOrderStats();
  const deleteDraft = useDeleteDraftOrderMutation();

  // The stats endpoint reports the workspace currency; fall back to the org
  // record while it is in flight so the KPI row does not flip currency on load.
  const currency = stats?.currency ?? org?.currency ?? "INR";

  const columns = useMemo<ColumnDef<DraftOrder>[]>(
    () => [
      {
        key: "draft",
        label: "Draft",
        width: 140,
        locked: true,
        sortKey: "name",
        sortType: "text",
        cell: (draft) => <IdCell>{draft.name ?? `Draft ${draft.id.slice(-6)}`}</IdCell>,
      },
      {
        key: "customer",
        label: "Customer",
        width: 220,
        cell: (draft) => (
          <TextCell muted={!draft.customer} className={!draft.customer ? "italic" : undefined}>
            {customerNameOf(draft)}
          </TextCell>
        ),
      },
      {
        key: "items",
        label: "Items",
        width: 90,
        cell: (draft) => (
          <TextCell muted>
            {draft.itemCount} item{draft.itemCount !== 1 ? "s" : ""}
          </TextCell>
        ),
      },
      {
        key: "total",
        label: "Total",
        width: 120,
        align: "right",
        sortKey: "totalPrice",
        sortType: "number",
        cell: (draft) => <MoneyCell amount={draft.totalPrice} currency={currency} strong />,
      },
      {
        key: "status",
        label: "Status",
        width: 120,
        cell: (draft) => (
          <StatusPill className={DRAFT_STATUS_CLASSES[draft.status]}>
            {DRAFT_STATUS_LABELS[draft.status]}
          </StatusPill>
        ),
      },
      {
        key: "updated",
        label: "Updated",
        width: 120,
        sortKey: "updatedAt",
        sortType: "date",
        cell: (draft) => <DateCell value={draft.updatedAt} />,
      },
      {
        key: "created",
        label: "Created",
        width: 120,
        hiddenByDefault: true,
        sortKey: "createdAt",
        sortType: "date",
        cell: (draft) => <DateCell value={draft.createdAt} />,
      },
    ],
    [currency],
  );

  const table = useDataTableState({
    key: "drafts",
    list,
    columns,
    tab: { param: "status", default: "all", values: CHIPS },
    sort: { default: { field: "updatedAt", dir: "desc" } },
  });

  const params: DraftOrderListParams = {
    page: table.page,
    limit: table.limit,
    search: table.debouncedSearch || undefined,
    status: table.tab === "all" ? undefined : (table.tab as DraftOrderStatus),
    sortBy: table.sort?.field,
    sortOrder: table.sort?.dir,
  };

  const { data, isLoading, isError, isPlaceholderData, refetch } = useDraftOrders(params);

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
      <div className={cn("grid grid-cols-1 gap-5 rounded-xl bg-card p-3 sm:grid-cols-2 lg:grid-cols-4", STAT_STRIP)}>
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

      <DataTable
        state={table}
        rows={data?.data ?? []}
        rowKey={(draft) => draft.id}
        meta={data?.meta}
        status={{ isLoading, isError, isPlaceholderData, refetch }}
        noun="drafts"
        tabs={{
          ariaLabel: "Filter drafts",
          items: [
            { value: "all", label: "All", count: stats?.counts.all },
            { value: "OPEN", label: "Open", count: stats?.counts.open },
            { value: "INVOICE_SENT", label: "Invoice sent", count: stats?.counts.invoiceSent },
            { value: "COMPLETED", label: "Completed", count: stats?.counts.completed },
          ],
        }}
        searchPlaceholder="Customer name or email…"
        onRowClick={(draft) => navigate(`/orders/drafts/${draft.id}`)}
        rowActions={(draft) => (
          <DraftRowActions
            draft={draft}
            onOpen={() => navigate(`/orders/drafts/${draft.id}`)}
            onDelete={() => deleteDraft.mutate(draft.id)}
            deleting={deleteDraft.isPending && deleteDraft.variables === draft.id}
          />
        )}
        emptyState={{
          icon: FileText,
          title: "No drafts yet",
          description:
            "Save an order as a draft from the order create page, or start a fresh one from here.",
          action: (
            <Button asChild variant="brand" size="sm">
              <Link to="/orders/drafts/new">
                <Plus className="size-3.5" />
                Create draft
              </Link>
            </Button>
          ),
        }}
      />
    </div>
  );
}

function DraftRowActions({
  draft,
  onOpen,
  onDelete,
  deleting,
}: {
  draft: DraftOrder;
  onOpen: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const isCompleted = draft.status === "COMPLETED";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={deleting}
          aria-label={`Actions for ${draft.name ?? "draft"}`}
        >
          {deleting ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <MoreHorizontal className="size-4 text-muted-foreground" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onOpen}>{isCompleted ? "View" : "Open"}</DropdownMenuItem>
        {!isCompleted && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
