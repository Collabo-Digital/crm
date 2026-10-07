import { oneOf, useSessionState } from "~/hooks/use-session-state";
import { useClampPage, useListUrlState } from "~/hooks/use-list-url-state";
import { useNavigate } from "react-router";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
  PageHeaderDescription,
} from "~/components/ui/page-header";
import { Separator } from "~/components/ui/separator";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { SectionCard } from "~/components/app/section-card";
import { ChannelBadge } from "~/components/app/channel-badge";
import { QueryErrorState } from "~/components/app/query-error-state";
import { StatCard } from "~/components/app/stat-card";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { EmptyState } from "~/components/app/empty-state";
import { Skeleton } from "~/components/ui/skeleton";
import { useCustomers, useCustomerStats } from "~/hooks/use-customer-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { cn, formatCurrency } from "~/lib/utils";
import { VIP_CLASSES, VIP_LABELS, VIP_ORDER } from "~/lib/customer-status";
import type {
  VipLevel,
  CustomerListParams,
  CustomerStatsResponse,
  ChangeDirection,
} from "~/types/api";
import { useDebounced } from "~/hooks/use-debounced";

export function meta() {
  return [{ title: "Customers | Collabo CRM" }];
}

const VIP_FILTERS: Array<"All" | VipLevel> = ["All", ...VIP_ORDER];

function getInitials(first: string | null | undefined, last: string | null | undefined) {
  const initials = `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase();
  return initials || "?";
}

/** A "down" direction is stored as a positive percentage — sign it for the badge. */
function signedChange(change: { percentage: number; direction: ChangeDirection }): number {
  return change.direction === "down" ? -change.percentage : change.percentage;
}

/**
 * Orders keys its equivalent array straight off `OrderStatsResponse` because all
 * four of its metrics share the `StatMetric` shape. `CustomerStatsResponse` is
 * heterogeneous — three plain numbers plus one `NewCustomersMetric` — so each
 * card resolves its own value instead.
 */
const STAT_CARDS: ReadonlyArray<{
  key: string;
  label: string;
  value: (stats: CustomerStatsResponse, currency: string) => string;
  /**
   * Omitted on every card but "New This Month". `StatCard` treats `change >= 0`
   * as positive, so passing 0 for a metric with no comparison period renders a
   * green up-trend badge — a failed request came out looking like four healthy
   * metrics.
   */
  change?: (stats: CustomerStatsResponse) => number;
  changeLabel?: string;
}> = [
  { key: "total", label: "Total Customers", value: (stats) => stats.totalCustomers.toLocaleString() },
  { key: "active", label: "Active Customers", value: (stats) => stats.activeCustomers.toLocaleString() },
  {
    key: "new",
    label: "New This Month",
    value: (stats) => stats.newCustomers.current.toLocaleString(),
    change: (stats) => signedChange(stats.newCustomers.change),
    changeLabel: "vs last month",
  },
  {
    key: "aov",
    label: "Avg. Order Value",
    value: (stats, currency) => formatCurrency(stats.averageOrderValue, currency),
  },
];

const PAGE_SIZE = 12;

export default function CustomersPage() {
  // Page and search live in the URL so Back from a customer returns to the
  // page the row was opened from.
  const list = useListUrlState("customers");
  const [vipFilter, setVipFilter] = useSessionState<"All" | VipLevel>(
    "customers.vip",
    "All",
    oneOf(["All", "NONE", "BRONZE", "SILVER", "GOLD", "PLATINUM"]),
  );
  const navigate = useNavigate();

  const { data: org } = useCurrentOrg();
  const gstEnabled = org?.gstEnabled ?? false;
  const orgCurrency = org?.currency ?? "USD";

  // Debounced into the query key only — the input keeps the raw value, so
  // typing stays instant without a request per keystroke.
  const debouncedSearch = useDebounced(list.search, 350);

  const params: CustomerListParams = {
    page: list.page,
    limit: PAGE_SIZE,
    search: debouncedSearch || undefined,
    vipLevel: vipFilter !== "All" ? vipFilter : undefined,
  };

  const { data, isLoading, isError, refetch } = useCustomers(params);
  const { data: stats, isLoading: statsLoading } = useCustomerStats();
  const customers = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;
  useClampPage(list, meta?.totalPages);

  function handleSearchChange(event: React.ChangeEvent<HTMLInputElement>) {
    list.setSearch(event.target.value);
  }

  function handleVipFilter(value: "All" | VipLevel) {
    setVipFilter(value);
    list.resetPage();
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Customers</PageHeaderTitle>
          <PageHeaderDescription>
            View and manage your customer database, segments, and activity.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-5 rounded-xl bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
        {statsLoading ? (
          Array.from({ length: STAT_CARDS.length }).map((_, i) => (
            <div key={i} className="p-5">
              <Skeleton className="h-3 w-24 mb-4" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : stats ? (
          STAT_CARDS.map(({ key, label, value, change, changeLabel }, i, arr) => (
            <div key={key} className="flex items-center gap-4">
              <StatCard
                variant="inline"
                label={label}
                value={value(stats, orgCurrency)}
                change={change?.(stats)}
                changeLabel={changeLabel}
                className="flex-1"
              />
              {i < arr.length - 1 && (
                <Separator orientation="vertical" className="hidden md:block h-15" />
              )}
            </div>
          ))
        ) : (
          /* No `change` on this branch — see the STAT_CARDS comment. */
          STAT_CARDS.map(({ key, label }) => (
            <StatCard key={key} variant="inline" label={label} value="—" />
          ))
        )}
      </div>

      {/* VIP filter. Search lives in the table card's header, matching orders.tsx. */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Single-select filter group, so `aria-pressed` rather than the
            tablist/tab roles used by order-activity.tsx — there is no tabpanel
            here for a tab to control. */}
        <div
          role="group"
          aria-label="Filter by VIP level"
          className="flex w-fit gap-1 rounded-full bg-muted p-1"
        >
          {VIP_FILTERS.map((filterValue) => (
            <button
              key={filterValue}
              type="button"
              aria-pressed={vipFilter === filterValue}
              onClick={() => handleVipFilter(filterValue)}
              className={cn(
                "rounded-full px-3 py-1 text-caption font-medium transition-colors",
                vipFilter === filterValue
                  ? "bg-ink font-semibold text-brand"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {filterValue === "All" ? "All" : VIP_LABELS[filterValue]}
            </button>
          ))}
        </div>
      </div>

      {/* Customers table. Search sits in the card header, matching orders.tsx. */}
      <SectionCard
        title="All Customers"
        description="Every customer synced from your channels, plus anyone added offline."
        action={
          <div className="relative min-w-50 max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search by name, email, or phone…"
              value={list.search}
              onChange={handleSearchChange}
              className="h-8 w-full rounded-lg border border-input bg-transparent pl-8 pr-3 text-caption placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
          </div>
        }
      >
        {/* The error branch MUST precede loading and empty: a failed request
            leaves isLoading false and data undefined, so `customers.length === 0`
            was reached and the user was told the store had simply synced
            nothing. `!data` keeps a failed background refetch from replacing a
            table that is already on screen. */}
        {isError && !data ? (
          <div className="p-8">
            <QueryErrorState resource="customers" onRetry={() => refetch()} />
          </div>
        ) : isLoading ? (
          <div className="p-4">
            <TableSkeleton rows={PAGE_SIZE} columns={gstEnabled ? 6 : 5} />
          </div>
        ) : customers.length === 0 ? (
          <div className="p-8">
            <EmptyState
              title="No customers found"
              description={
                list.search
                  ? "Try adjusting your search or filters."
                  : "Customers will appear here once synced from your channels."
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Customer</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Total Spent</TableHead>
                  {gstEnabled && <TableHead>GSTIN</TableHead>}
                  <TableHead>VIP Level</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((customer) => {
                  const name =
                    [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
                    customer.email ||
                    "—";
                  return (
                    <TableRow
                      key={customer.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/orders/customers/${customer.id}`)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-caption font-semibold text-brand-foreground">
                            {getInitials(customer.firstName, customer.lastName)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-caption font-medium text-foreground">{name}</p>
                            <p className="truncate text-caption text-muted-foreground">{customer.email}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-caption text-muted-foreground">
                        <ChannelBadge
                          platform={customer.channel?.platform}
                          name={customer.channel?.name}
                        />
                      </TableCell>
                      <TableCell className="text-right text-caption font-medium tabular-nums text-foreground">
                        {customer.ordersCount}
                      </TableCell>
                      <TableCell className="text-right text-caption font-semibold tabular-nums text-foreground">
                        {formatCurrency(customer.totalSpent, orgCurrency)}
                      </TableCell>
                      {gstEnabled && (
                        <TableCell className="font-mono text-caption text-muted-foreground">
                          {customer.gstin || (
                            <span className="text-micro italic text-muted-foreground">Not set</span>
                          )}
                        </TableCell>
                      )}
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium",
                            VIP_CLASSES[customer.vipLevel],
                          )}
                        >
                          {VIP_LABELS[customer.vipLevel]}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {!isLoading && customers.length > 0 && (
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
