import { useEffect, useMemo, useState } from "react";
import {
  type DateRangePreset,
  type OrderRangePreset,
  orderRangeDates,
} from "~/hooks/use-date-range-filter";
import { useListUrlState } from "~/hooks/use-list-url-state";
import { Link, useNavigate } from "react-router";
import {
  Download, Upload, ShoppingBag, Package, Loader2,
  Target, Box, Plus, Printer, FileText, MoreHorizontal,
} from "lucide-react";
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
import { DataTable, useDataTableState, type FilterDef } from "~/components/app/data-table";
import { OrderMobileSummary, OrderRowActions, useOrderColumns } from "~/components/app/orders-table";
import { ShopifySyncCell } from "~/components/app/shopify-sync-cell";
import { describeOrderShopifySync } from "~/lib/shopify-sync";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { DockButton, FloatingDock } from "~/components/app/floating-dock";
import { BulkInvoiceDialog } from "~/components/app/bulk-invoice-dialog";
import { useInvoiceActionGates } from "~/hooks/use-invoice-action-gates";
import { Skeleton } from "~/components/ui/skeleton";
import { Separator } from "~/components/ui/separator";
import { formatCurrency } from "~/lib/utils";
import { useExclusiveDownload } from "~/hooks/use-exclusive-download";
import { reportingTimeZone, todayIn } from "~/lib/reporting-date";
import { useOrders, useOrderStats } from "~/hooks/use-order-queries";
import { useChannels } from "~/hooks/use-channel-queries";
import { FULFILLMENT_FILTER_OPTIONS, PAYMENT_FILTER_OPTIONS } from "~/lib/order-status";
import { comparedChange, comparedLabel, type TrendGoodWhen } from "~/lib/trend";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { useCurrentRole } from "~/hooks/use-current-role";
import { orderService } from "~/services/order.service";
import { dashboardService } from "~/services/dashboard.service";
import type {
  ChannelPlatform,
  DashboardQueryParams,
  FulfillmentStatus,
  Order,
  OrderListParams,
  OrderPaymentFilter,
  OrderStatsResponse,
} from "~/types/api";

export function meta() {
  return [
    { title: "Orders | Collabo CRM" },
    { name: "description", content: "Manage and track all your orders" },
  ];
}

const DATE_RANGE_PRESETS: ReadonlyArray<DateRangePreset<OrderRangePreset>> = [
  { value: "all", label: "All Time" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "90d", label: "Last 90 Days" },
];

type OrderStatKey = Exclude<keyof OrderStatsResponse, "period">;

const STAT_CARDS: ReadonlyArray<{
  key: OrderStatKey;
  label: string;
  icon: React.ReactNode;
  /** Renders the value through formatCurrency instead of toLocaleString. */
  currency?: boolean;
  /** A growing backlog is bad news, so its rise is red. */
  goodWhen?: TrendGoodWhen;
}> = [
  { key: "totalNewOrders", label: "Total New Orders", icon: <ShoppingBag className="size-4" /> },
  { key: "pendingOrders", label: "Pending Orders", icon: <Package className="size-4" />, goodWhen: "down" },
  { key: "totalSales", label: "Total Sales", icon: <Target className="size-4" />, currency: true },
  { key: "totalProductsSold", label: "Products Sold", icon: <Box className="size-4" /> },
];

/** Chat channels never hold orders, so the Channel filter leaves them out. */
const CHAT_PLATFORMS: ReadonlyArray<ChannelPlatform> = ["WHATSAPP", "INSTAGRAM", "FACEBOOK"];

export default function OrdersPage() {
  // The whole view — page, search, date range, sort, page size — lives in the
  // URL so Back from an order (and the order page's breadcrumb) return to the
  // exact list the row was opened from.
  const list = useListUrlState("orders");
  const navigate = useNavigate();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkInvoiceOpen, setBulkInvoiceOpen] = useState(false);
  const { canIssue } = useInvoiceActionGates();

  const { data: org } = useCurrentOrg();
  const gstEnabled = org?.gstEnabled ?? false;
  const orgCurrency = org?.currency ?? "USD";
  const timeZone = reportingTimeZone(org?.timezone);

  // Mirrors ORG_MANAGERS / ORG_OPERATORS — see OrderRowActions.
  const { role, isVendor } = useCurrentRole();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";
  const canOperate = canManage || role === "AGENT";
  const showShopifyColumn = !isVendor;

  const columns = useOrderColumns({ currency: orgCurrency, showShopifyColumn, showPaymentColumn: !isVendor });
  const { data: channels } = useChannels();
  // A vendor's rows carry neither payment nor channel, so they filter by
  // fulfilment only.
  const filters = useMemo<FilterDef[]>(
    () => [
      ...(isVendor ? [] : [{ key: "payment", label: "Payment", options: PAYMENT_FILTER_OPTIONS }]),
      { key: "fulfillment", label: "Fulfilment", options: FULFILLMENT_FILTER_OPTIONS },
      ...(isVendor
        ? []
        : [
          {
            key: "channel",
            label: "Channel",
            options: channels
              ?.filter((c) => !CHAT_PLATFORMS.includes(c.platform))
              .map((c) => ({ value: c.id, label: c.name })),
          },
        ]),
    ],
    [channels, isVendor],
  );
  const table = useDataTableState({
    key: "orders",
    list,
    columns,
    filters,
    sort: { default: { field: "externalCreatedAt", dir: "desc" } },
    // Opens on 7 days rather than All Time: all-time stats scan every order.
    date: {
      presets: DATE_RANGE_PRESETS,
      default: "7d",
      custom: true,
      today: todayIn(timeZone),
    },
  });

  const dateFilter = {
    preset: (table.date?.preset ?? "7d") as OrderRangePreset,
    custom: table.date?.custom ?? null,
  };
  const { dateFrom, dateTo } = orderRangeDates(dateFilter, timeZone);
  /** File-name part for exports: the preset key, or the two dates. */
  const fileTag = dateFilter.custom
    ? `${dateFilter.custom.from}-to-${dateFilter.custom.to}`
    : dateFilter.preset;

  // A search looks through every date unless a range was picked on purpose.
  // Searching inside the 7-day default answered "No orders match" for last
  // month's order, or anyone's phone number.
  const searchAllDates = table.debouncedSearch.trim() !== "" && table.isDefaultDate;
  const payment = table.filters.payment?.[0] as OrderPaymentFilter | undefined;
  const fulfillmentStatus = table.filters.fulfillment?.[0] as FulfillmentStatus | undefined;
  const channelId = table.filters.channel?.[0];

  const params: OrderListParams = {
    page: table.page,
    limit: table.limit,
    search: table.debouncedSearch || undefined,
    ...(searchAllDates ? {} : { dateFrom, dateTo }),
    payment,
    fulfillmentStatus,
    channelId,
    sortBy: table.sort?.field,
    sortOrder: table.sort?.dir,
  };

  const statsParams: DashboardQueryParams | undefined =
    dateFrom || dateTo ? { dateFrom, dateTo } : undefined;

  const { data, isLoading, isError, isPlaceholderData, refetch } = useOrders(params);
  const { data: stats, isLoading: statsLoading } = useOrderStats(statsParams);
  // One download at a time across both header buttons.
  const { running: activeDownload, run: startDownload } = useExclusiveDownload<"report" | "json">();
  const orders = data?.data ?? [];

  // Selection is cleared whenever the visible rows change. Printing slips for
  // orders that scrolled out of view is unrecoverable — you only find out at
  // the printer — so the selection never outlives the page it was made on.
  // Same reasoning as the inventory label picker.
  const sortField = table.sort?.field;
  const sortDir = table.sort?.dir;
  useEffect(() => {
    setSelectedIds(new Set());
  }, [table.page, table.limit, table.debouncedSearch, dateFrom, dateTo, sortField, sortDir, payment, fulfillmentStatus, channelId]);

  function toggleRow(order: Order, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(order.id);
      else next.delete(order.id);
      return next;
    });
  }

  function toggleAllOnPage(rows: ReadonlyArray<Order>, checked: boolean) {
    setSelectedIds(checked ? new Set(rows.map((o) => o.id)) : new Set());
  }

  const slipHref =
    selectedIds.size > 0
      ? `/orders/slips/print?orderIds=${[...selectedIds].join(",")}`
      : null;

  // Selection never outlives the page (see above), so every selected order is
  // on screen. The total is only shown when they share a currency — a mixed
  // selection has no single figure that would be true.
  const selectedOrders = orders.filter((o) => selectedIds.has(o.id));
  const selectedCurrencies = new Set(selectedOrders.map((o) => o.currency || orgCurrency));
  const selectedTotal =
    selectedCurrencies.size === 1
      ? formatCurrency(
          selectedOrders.reduce((sum, o) => sum + Number(o.totalPrice), 0),
          [...selectedCurrencies][0],
        )
      : undefined;

  const downloadReport = () => startDownload(
    "report",
    () => dashboardService.exportCsv(statsParams),
    `orders-report-${fileTag}.csv`,
    "Couldn't download the report. Please try again.",
  );
  const exportOrders = () => startDownload(
    "json",
    () => orderService.exportJson({ dateFrom, dateTo }),
    `orders-${fileTag}.json`,
    "Couldn't export the orders. Please try again.",
  );

  return (
    // Bottom padding while the bulk-action dock is up, so it never covers the
    // pagination row.
    <div className={slipHref ? "space-y-6 pb-24" : "space-y-6"}>
      {/* Page header */}
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Orders</PageHeaderTitle>
          <PageHeaderDescription>
            Track sales, payments, and fulfillment.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="w-full justify-end md:w-auto">
          {/* "Download Report" is the dashboard's order CSV for the chosen
              date range. "Export JSON" is the same orders as a JSON file via
              the orders export route. Both take the date range only — the
              search box is deliberately not applied, so the request does not
              claim a filter the file lacks.
              Both lock while either runs; the clicked one shows progress
              until its file arrives or fails. */}
          {!isVendor && (
            <div className="hidden items-center gap-2 md:flex">
              <Button
                variant="brand"
                size="action"
                disabled={activeDownload !== null}
                aria-busy={activeDownload === "report"}
                onClick={downloadReport}
              >
                {activeDownload === "report" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {activeDownload === "report" ? "Preparing…" : "Download Report"}
              </Button>
              <Button
                variant="outline"
                size="action"
                disabled={activeDownload !== null}
                aria-busy={activeDownload === "json"}
                onClick={exportOrders}
              >
                {activeDownload === "json" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                {activeDownload === "json" ? "Exporting…" : "Export JSON"}
              </Button>
            </div>
          )}
          {!isVendor && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="mr-auto size-11 rounded-xl md:hidden" aria-label="More order actions">
                  <MoreHorizontal className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={downloadReport} disabled={activeDownload !== null}><Download /> Download report</DropdownMenuItem>
                <DropdownMenuItem onSelect={exportOrders} disabled={activeDownload !== null}><Upload /> Export JSON</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button asChild variant="brand" size="action" className="h-11 rounded-xl px-5 md:h-8 md:rounded-lg md:px-3">
            <Link to="/orders/new">
              <Plus className="size-3.5" />
              Create Order
            </Link>
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 rounded-3xl bg-card p-4 md:gap-5 md:rounded-xl md:p-3 lg:grid-cols-4">
        {statsLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="min-w-0 p-1 md:p-5">
              <Skeleton className="h-3 w-24 mb-4" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))
        ) : stats ? (
          STAT_CARDS.map(({ key, label, icon, currency, goodWhen }, i, arr) => {
            const metric = stats[key];
            return (
              <div key={key} className="flex min-w-0 items-center gap-4">
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
                  change={comparedChange(metric)}
                  goodWhen={goodWhen}
                  changeLabel={comparedLabel(metric)}
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
          /* No `change` here: a failed stats request has no trend to show. */
          STAT_CARDS.map(({ key, label, icon }) => (
            <StatCard key={key} variant="inline" label={label} value="—" icon={icon} />
          ))
        )}
      </div>

      <DataTable
        state={table}
        rows={orders}
        rowKey={(order) => order.id}
        meta={data?.meta}
        status={{ isLoading, isError, isPlaceholderData, refetch }}
        noun="orders"
        searchPlaceholder="Search order #, customer, email or phone…"
        dateLabel={searchAllDates ? "All dates while searching" : undefined}
        onRowClick={(order) => navigate(`/orders/${order.id}`)}
        mobileRow={(order) => (
          <>
            <OrderMobileSummary order={order} currency={orgCurrency} />
            {showShopifyColumn && <div className="mt-3"><ShopifySyncCell summary={describeOrderShopifySync(order)} /></div>}
          </>
        )}
        selection={{
          isSelected: (order) => selectedIds.has(order.id),
          onToggle: toggleRow,
          onToggleAll: toggleAllOnPage,
          label: (order) => `Select order ${order.name}`,
        }}
        rowActions={(order) => (
          <OrderRowActions
            order={order}
            canOperate={canOperate}
            canManage={canManage}
            gstEnabled={gstEnabled}
            showShopifyColumn={showShopifyColumn}
            onViewDetail={(id) => navigate(`/orders/${id}`)}
          />
        )}
        actionsWidth={canOperate && showShopifyColumn ? 128 : 56}
        // The default 7 days is not a filter, so a quiet week used to read
        // "No orders yet" while older orders existed.
        emptyState={
          dateFilter.preset === "all" && !dateFilter.custom
            ? {
              title: "No orders yet",
              description: "Orders will appear here once synced from your channels.",
            }
            : {
              title: "No orders in this period",
              description: "Older orders are still here. Show all dates, or search by order number, name or phone.",
              action: (
                <Button variant="outline" size="sm" onClick={() => table.setDatePreset("all")}>
                  Show all dates
                </Button>
              ),
            }
        }
      />

      {slipHref && (
        <FloatingDock
          count={selectedIds.size}
          noun={selectedIds.size === 1 ? "order" : "orders"}
          summary={selectedTotal}
          onClear={() => setSelectedIds(new Set())}
        >
          {/* Opens in a new tab so the selection and scroll position survive
              the print job — the operator comes straight back to the list to
              pick the next batch. */}
          <DockButton asChild>
            <Link to={slipHref} target="_blank" rel="noreferrer">
              <Printer />
              Print package slips
            </Link>
          </DockButton>
          {/* Same gate as the order page's Generate button: the server only
              lets ORG_MANAGERS issue, and only with GST enabled. */}
          {gstEnabled && canIssue && (
            <DockButton onClick={() => setBulkInvoiceOpen(true)}>
              <FileText />
              Generate GST invoices
            </DockButton>
          )}
        </FloatingDock>
      )}

      <BulkInvoiceDialog
        open={bulkInvoiceOpen}
        orderIds={[...selectedIds]}
        onClose={(done) => {
          setBulkInvoiceOpen(false);
          // A submitted batch has been acted on; keeping the ticks would invite
          // re-submitting it.
          if (done) setSelectedIds(new Set());
        }}
      />
    </div>
  );
}
