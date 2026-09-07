import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  Search, Download, Upload, ChevronLeft, ChevronRight, ShoppingBag, Package,
  Target, Box, Plus, Printer,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
  PageHeaderDescription,
  PageHeaderActions,
} from "~/components/ui/page-header";
import { StatCard } from "~/components/app/stat-card";
import { MoneyTotal } from "~/components/app/money-total";
import { SectionCard } from "~/components/app/section-card";
import { OrdersTable } from "~/components/app/orders-table";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { EmptyState } from "~/components/app/empty-state";
import { QueryErrorState } from "~/components/app/query-error-state";
import { useDebounced } from "~/hooks/use-debounced";
import { Skeleton } from "~/components/ui/skeleton";
import { Separator } from "~/components/ui/separator";
import { formatCurrency } from "~/lib/utils";
import { downloadBlob } from "~/lib/download-blob";
import { useOrders, useOrderStats } from "~/hooks/use-order-queries";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { orderService } from "~/services/order.service";
import { dashboardService } from "~/services/dashboard.service";
import type { OrderListParams, DashboardQueryParams, OrderStatsResponse } from "~/types/api";

export function meta() {
  return [
    { title: "Orders | Collabo CRM" },
    { name: "description", content: "Manage and track all your orders" },
  ];
}

const PAGE_SIZE = 9;

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

const DATE_RANGE_MAP: Record<string, number | null> = { all: null, "7d": 7, "30d": 30, "90d": 90 };

type OrderStatKey = Exclude<keyof OrderStatsResponse, "period">;

const STAT_CARDS: ReadonlyArray<{
  key: OrderStatKey;
  label: string;
  icon: React.ReactNode;
  /** Renders the value through formatCurrency instead of toLocaleString. */
  currency?: boolean;
}> = [
  { key: "totalNewOrders", label: "Total New Orders", icon: <ShoppingBag className="size-4" /> },
  { key: "pendingOrders", label: "Pending Orders", icon: <Package className="size-4" /> },
  { key: "totalSales", label: "Total Sales", icon: <Target className="size-4" />, currency: true },
  { key: "totalProductsSold", label: "Products Sold", icon: <Box className="size-4" /> },
];

export default function OrdersPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [dateRange, setDateRange] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: org } = useCurrentOrg();
  const gstEnabled = org?.gstEnabled ?? false;
  const orgCurrency = org?.currency ?? "USD";

  const daysBack = DATE_RANGE_MAP[dateRange];
  const dateFrom = daysBack != null ? daysAgo(daysBack) : undefined;

  // The input stays bound to the raw value so typing feels instant; only the
  // debounced copy reaches the query key. Without this every keystroke was a
  // fresh cache key and therefore its own request — "shirt" was five.
  const debouncedSearch = useDebounced(searchQuery, 350);

  const params: OrderListParams = {
    page: currentPage,
    limit: PAGE_SIZE,
    search: debouncedSearch || undefined,
    dateFrom,
  };

  const statsParams: DashboardQueryParams | undefined = dateFrom ? { dateFrom } : undefined;

  const { data, isLoading, isError, refetch } = useOrders(params);
  const { data: stats, isLoading: statsLoading } = useOrderStats(statsParams);
  const orders = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  // Selection is cleared whenever the visible rows change. Printing slips for
  // orders that scrolled out of view is unrecoverable — you only find out at
  // the printer — so the selection never outlives the page it was made on.
  // Same reasoning as the inventory label picker.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [currentPage, debouncedSearch, dateRange]);

  function toggleRow(orderId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelectedIds((prev) => {
      const allSelected = orders.length > 0 && orders.every((o) => prev.has(o.id));
      return allSelected ? new Set() : new Set(orders.map((o) => o.id));
    });
  }

  const slipHref =
    selectedIds.size > 0
      ? `/orders/slips/print?orderIds=${[...selectedIds].join(",")}`
      : null;

  function handleSearchChange(event: React.ChangeEvent<HTMLInputElement>) {
    setSearchQuery(event.target.value);
    setCurrentPage(1);
  }

  function handleDateRangeChange(value: string) {
    setDateRange(value);
    setCurrentPage(1);
  }

  function formatChange(direction: "up" | "down" | "same", percentage: number) {
    return direction === "down" ? -percentage : percentage;
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Orders</PageHeaderTitle>
          <PageHeaderDescription>
            An overview of recent data of customers info, products details and analysis.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Select value={dateRange} onValueChange={handleDateRangeChange}>
            <SelectTrigger className="h-8 w-30 rounded-lg text-caption font-medium shadow-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Time</SelectItem>
              <SelectItem value="7d">Last 7 Days</SelectItem>
              <SelectItem value="30d">Last 30 Days</SelectItem>
              <SelectItem value="90d">Last 90 Days</SelectItem>
            </SelectContent>
          </Select>
          {/* Exports exactly what the page is showing: `params` carries the
              active search and date range, and the server's export route takes
              the same DTO as the list. This button had no onClick at all. */}

          {/* The dashboard's summary report. This used to call
              `invoiceService.exportCsv` and save `gst-invoices-*.csv` — a
              copy-paste from the invoices page that also ignored the search box
              and forced `dateTo` to today. */}
          <Button
            variant="brand"
            size="action"
            onClick={() => downloadBlob(
              () => dashboardService.exportCsv(statsParams),
              `orders-report-${dateRange}.csv`,
              "Failed to download report.",
            )}
          >
            <Download className="size-3.5" />
            Download Report
          </Button>
          <Button
            variant="outline"
            size="action"
            onClick={() => downloadBlob(
              () => orderService.exportCsv(params),
              `orders-${dateRange}.csv`,
              "Failed to export orders.",
            )}
          >
            <Upload className="size-3.5" />
            Export CSV
          </Button>
          <Button asChild variant="brand" size="action">
            <Link to="/orders/new">
              <Plus className="size-3.5" />
              Create Order
            </Link>
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white dark:bg-gray-900 p-3 rounded-xl gap-5">
        {statsLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="p-5">
              <Skeleton className="h-3 w-24 mb-4" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : stats ? (
          STAT_CARDS.map(({ key, label, icon, currency }, i, arr) => {
            const metric = stats[key];
            return (
              <div key={key} className="flex items-center gap-4">
                <StatCard
                  variant="inline"
                  label={label}
                  value={
                    currency ? (
                      <MoneyTotal
                        amount={Number(metric.current)}
                        currency={metric.currency ?? orgCurrency}
                        breakdown={metric.byCurrency}
                        unconverted={metric.unconverted}
                      />
                    ) : (
                      Number(metric.current).toLocaleString()
                    )
                  }
                  {...(metric.change
                    ? {
                      change: formatChange(metric.change.direction, metric.change.percentage),
                      changeLabel: "vs previous period",
                    }
                    : {})}
                  icon={icon}
                  className="flex-1"
                />
                {i < arr.length - 1 && (
                  <Separator orientation="vertical" className="hidden md:block h-15" />
                )}
              </div>
            );
          })
        ) : (
          /* No `change` here — passing 0 renders a GREEN "0%" up-trend badge
             (the card treats `change >= 0` as positive), so a failed stats
             request comes out looking like four healthy metrics. */
          STAT_CARDS.map(({ key, label, icon }) => (
            <StatCard key={key} variant="inline" label={label} value="—" icon={icon} />
          ))
        )}
      </div>

      {/* Orders table with search and pagination */}
      <SectionCard
        title="All Orders"
        description="Keep track of recent order data and others information."
        action={
          <div className="flex items-center gap-2">
            {/* Opens in a new tab so the selection and scroll position survive
                the print job — the operator comes straight back to the list to
                pick the next batch. */}
            {slipHref && (
              <Button asChild variant="outline" size="action">
                <Link to={slipHref} target="_blank" rel="noreferrer">
                  <Printer className="size-3.5" />
                  Print package slips ({selectedIds.size})
                </Link>
              </Button>
            )}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search here..."
                value={searchQuery}
                onChange={handleSearchChange}
                className="h-8 w-48 rounded-lg border border-input bg-transparent pl-8 pr-3 text-caption placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
              />
            </div>
          </div>
        }
      >

        {/* Table body */}
        {/* The error branch MUST precede the loading and empty branches. A
            failed request leaves isLoading false and data undefined, so
            `orders.length === 0` was reached and the user was told the store
            had simply synced with nothing in it. `!data` keeps a failed
            background refetch from replacing a table that is already on
            screen. */}
        {isError && !data ? (
          <div className="p-8">
            <QueryErrorState resource="orders" onRetry={() => refetch()} />
          </div>
        ) : isLoading ? (
          <div className="p-4">
            <TableSkeleton rows={PAGE_SIZE} columns={7} />
          </div>
        ) : orders.length === 0 ? (
          <div className="p-8">
            <EmptyState
              title="No orders found"
              description={searchQuery ? "Try adjusting your search." : "Orders will appear here once synced from your channels."}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <OrdersTable
              orders={orders}
              currency={orgCurrency}
              showCustomerName
              gstEnabled={gstEnabled}
              selectedIds={selectedIds}
              onToggleRow={toggleRow}
              onToggleAll={toggleAllOnPage}
            />
          </div>
        )}

        {/* Pagination controls */}
        {!isLoading && orders.length > 0 && (
          <div className="flex items-center justify-between border-t px-5 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
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
              onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={currentPage >= totalPages}
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
