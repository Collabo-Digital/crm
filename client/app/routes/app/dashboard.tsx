import { lazy, Suspense } from "react";
import { type DateRangePreset, useDateRangeFilter } from "~/hooks/use-date-range-filter";
import { ArrowRight, Download, Loader2, Upload, Target, Users, ShoppingBag, MessageSquare, Package, Plus, MoreHorizontal } from "lucide-react";
import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { DateRangeFilter } from "~/components/app/date-range-filter";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
  PageHeaderDescription,
  PageHeaderActions,
} from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { OrdersTable } from "~/components/app/orders-table";
import { TopProductsPanel } from "~/components/app/top-products-panel";
import { LowStockProductsPanel } from "~/components/app/low-stock-products-panel";
import { TableSkeleton } from "~/components/app/table-skeleton";
import { EmptyState } from "~/components/app/empty-state";
import {
  useDashboard,
  useExportDashboard,
  useSalesAndProfit,
} from "~/hooks/use-dashboard-queries";
import type { SparklinePoint } from "~/components/app/chart-line-default";
import type { SalesProfitPoint } from "~/services/dashboard.service";
import type { DashboardQueryParams, DashboardRange } from "~/types/api";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { reportingTimeZone, todayIn } from "~/lib/reporting-date";
import { cn, formatCurrency } from "~/lib/utils";
import { StatCard } from "~/components/app/stat-card";
import { MoneyTotal } from "~/components/app/money-total";
import { ProductsPanel } from "~/components/app/products-panel";
import { SectionCard } from "~/components/app/section-card";
import { useAuthStore } from "~/stores/auth.store";
import { useSectionAccess } from "~/hooks/use-section-access";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";

// Lazy so the page shell renders and both data requests start while the
// recharts chunk is still downloading. The hooks stay in this route, so the
// chart finds its data already in the query cache when it mounts.
const ProfitBarChart = lazy(() =>
  import("~/components/app/profit-bar-chart").then((m) => ({
    default: m.ProfitBarChart,
  }))
);

/** Same card shell as ProfitBarChart, so the column doesn't jump when it lands. */
const profitChartFallback = (
  <div className="flex h-full flex-col rounded-xl bg-card p-5 shadow-sm ring-1 ring-border">
    <p className="mb-3 text-body font-semibold text-foreground">Gross Profit</p>
    <Skeleton className="mb-3 h-7 w-32" />
    <Skeleton className="min-h-40 flex-1" />
  </div>
);

export function meta() {
  return [
    { title: "Dashboard | Collabo CRM" },
    { name: "description", content: "Overview of your CRM data" },
  ];
}

const RANGE_OPTIONS: ReadonlyArray<DateRangePreset<DashboardRange>> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
];

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);
  const { canAccess } = useSectionAccess();
  // One window for the whole page. Total Sales used to be an all-time figure
  // sitting beside a chart hard-coded to a rolling 12 months, so the two could
  // never be reconciled and neither said which period it covered.
  // Opens on 7 days: the narrowest window is the cheapest first load. A wider
  // choice, or a custom range, is remembered for the browser session.
  const range = useDateRangeFilter<DashboardRange>("dashboard.range", "7d", RANGE_OPTIONS);
  // A preset sends `range`, a custom range sends its dates; never both, since
  // the server lets explicit dates win and the two would disagree silently.
  const params: DashboardQueryParams = range.custom
    ? { dateFrom: range.custom.from, dateTo: range.custom.to }
    : { range: range.preset };

  const {
    data: dashboard,
    isLoading,
    isPlaceholderData: overviewStale,
  } = useDashboard(params);
  const { downloadReport, exportJson, exporting } = useExportDashboard();
  const { data: org } = useCurrentOrg();
  const timeZone = reportingTimeZone(org?.timezone);
  // Same params as the chart below, so React Query serves both from one
  // request and the cards cannot disagree with the bars.
  const {
    data: sales,
    isLoading: salesLoading,
    isPlaceholderData: salesStale,
  } = useSalesAndProfit(params);
  const orgCurrency = org?.currency ?? "USD";
  const recentOrders = dashboard?.recentOrders ?? [];
  const series = sales?.data;
  const totals = sales?.totals;
  const periodLabel = sales?.period.label ?? "";

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div>
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle><span className="md:hidden">Hello{user?.firstName ? `, ${user.firstName}` : ""}.</span><span className="hidden md:inline">Overview</span></PageHeaderTitle>
            <PageHeaderDescription>
              Your store, at a glance.
            </PageHeaderDescription>
          </PageHeaderContent>
          <PageHeaderActions className="max-md:w-full max-md:justify-between">
            <DateRangeFilter
              presets={RANGE_OPTIONS}
              preset={range.preset}
              custom={range.custom}
              label={range.label}
              today={todayIn(timeZone)}
              onPresetChange={range.selectPreset}
              onCustomApply={range.applyCustom}
            />
            {/* One download at a time: both lock while either runs, and the
                clicked one shows progress until its file arrives or fails. */}
            <Button
              size="action"
              className="hidden md:inline-flex"
              variant="outline"
              onClick={() => exportJson(params)}
              disabled={exporting !== null}
              aria-busy={exporting === "json"}
            >
              {exporting === "json" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {exporting === "json" ? "Exporting…" : "Export JSON"}
            </Button>
            <Button
              variant="brand"
              className="hidden md:inline-flex"
              size="action"
              onClick={() => downloadReport(params)}
              disabled={exporting !== null}
              aria-busy={exporting === "report"}
            >
              {exporting === "report" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {exporting === "report" ? "Preparing…" : "Download Report"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="icon" className="rounded-full md:hidden" aria-label="Dashboard actions"><MoreHorizontal className="size-5" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={exporting !== null} onClick={() => downloadReport(params)}><Download className="size-4" />Download report</DropdownMenuItem>
                <DropdownMenuItem disabled={exporting !== null} onClick={() => exportJson(params)}><Upload className="size-4" />Export JSON</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </PageHeaderActions>
        </PageHeader>
      </div>

      <div className={cn("space-y-3 md:hidden", (overviewStale || salesStale) && "opacity-50")}>
        <section aria-label="Sales summary" className="relative overflow-hidden rounded-[26px] bg-brand-forest p-6 text-white">
          <div aria-hidden className="pointer-events-none absolute -right-10 -top-14 size-44 rounded-full border-[28px] border-brand/10" />
          <div className="relative">
            <div className="flex items-center justify-between gap-3"><p className="text-sm text-white/75">Total sales</p><span className="rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/90">{range.label}</span></div>
            <div className="my-5 break-words text-[36px] font-semibold leading-tight tracking-[-1.4px] [&_.text-caption]:tracking-normal [&_.text-muted-foreground]:text-white/70 [&_.text-warning]:text-amber-200">
              {salesLoading ? <Skeleton className="h-11 w-40 bg-white/15" /> : totals ? <MoneyTotal amount={totals.grossSales} currency={totals.currency ?? orgCurrency} breakdown={totals.salesByCurrency} unconverted={totals.unconvertedOrders} /> : "—"}
            </div>
            {canAccess("/orders") && <Link to="/orders" className="flex min-h-12 items-center justify-between rounded-2xl bg-brand px-4 text-sm font-semibold text-brand-foreground">View your orders<ArrowRight className="size-4" /></Link>}
          </div>
        </section>
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Orders" value={dashboard?.totalOrders.toLocaleString()} icon={<ShoppingBag />} isLoading={isLoading} className="rounded-[22px] shadow-none ring-0" />
          <StatCard label="New customers" value={dashboard?.totalCustomers.toLocaleString()} icon={<Users />} isLoading={isLoading} className="rounded-[22px] shadow-none ring-0" />
        </div>
        <div className="grid grid-cols-3 gap-2 pt-2">
          {[
            { href: "/orders/new", label: "New order", icon: Plus },
            { href: "/inbox", label: "Inbox", icon: MessageSquare },
            { href: "/products", label: "Products", icon: Package },
          ].filter((item) => canAccess(item.href)).map(({ href, label, icon: Icon }) => <Link key={href} to={href} className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-2xl bg-card text-xs font-medium transition-colors active:bg-brand/30"><Icon className="size-5 text-brand-strong" strokeWidth={1.7} />{label}</Link>)}
        </div>
      </div>

      {/* Stat cards row */}
      <div className="flex flex-col gap-4 md:flex-row md:gap-3">
        {/* On a range switch the previous window's figures stay up, dimmed,
            until the new ones land — no drop back to skeletons. */}
        <div
          className={cn(
            "hidden min-w-0 flex-1 flex-col overflow-hidden rounded-lg ring-1 ring-border divide-y divide-border transition-opacity md:flex",
            (overviewStale || salesStale) && "opacity-50"
          )}
        >
          {/* Reads the SAME payload as the profit chart — this is the figure the
              chart's reconciliation strip walks down from. */}
          <StatCard
            sparkline
            sparklineData={sparklineFor(series, "grossSales")}
            label="Total Sales"
            value={
              totals ? (
                <MoneyTotal
                  amount={totals.grossSales}
                  currency={totals.currency ?? orgCurrency}
                  breakdown={totals.salesByCurrency}
                  unconverted={totals.unconvertedOrders}
                />
              ) : undefined
            }
            changeLabel={periodLabel}
            icon={<Target className="size-4" />}
            linkTo="/orders"
            linkLabel="View Sales"
            isLoading={salesLoading}
          />
          {/* <StatCard
          label="Active Products"
          value={dashboard ? dashboard.totalProducts.toLocaleString() : undefined}
          icon={<Box className="size-4" />}
          linkTo="/products"
          linkLabel="View Products"
          isLoading={isLoading}
        /> */}
          <StatCard
            sparkline
            sparklineData={sparklineFor(series, "orders")}
            label="Total Orders"
            value={dashboard ? dashboard.totalOrders.toLocaleString() : undefined}
            changeLabel={periodLabel}
            icon={<ShoppingBag className="size-4" />}
            linkTo="/orders"
            linkLabel="View Orders"
            isLoading={isLoading}
          />
          {/* "New" rather than "Total": the sparkline beside it has always
              plotted per-period signups, and the count is now windowed to
              match the rest of the page. */}
          <StatCard
            sparkline
            sparklineData={sparklineFor(series, "newCustomers")}
            label="New Customers"
            value={dashboard ? dashboard.totalCustomers.toLocaleString() : undefined}
            changeLabel={periodLabel}
            icon={<Users className="size-4" />}
            linkTo="/orders/customers"
            linkLabel="View Customers"
            isLoading={isLoading}
          />
        </div>

        {/* Charts row — 2 equal columns */}
        <div className="flex min-w-0 flex-col flex-2 overflow-hidden rounded-lg ring-1 ring-border divide-y divide-border">
          <Suspense fallback={profitChartFallback}>
            <ProfitBarChart currency={orgCurrency} params={params} />
          </Suspense>
          {/* <SalesDonutChart currency={orgCurrency} /> */}
        </div>
      </div>

      {/* Bottom row — recent orders table and top products */}
      <div
        className={cn(
          "flex flex-col gap-4 justify-between transition-opacity lg:flex-row lg:gap-3",
          overviewStale && "opacity-50"
        )}
      >
        <SectionCard
          className="flex min-w-0 flex-2 flex-col"
          title="Recent Orders"
          description="Your latest orders and their status."
          action={
            <Link to="/orders" className="flex items-center gap-1 text-caption font-medium text-brand-strong hover:text-brand-strong-hover">
              View All <ArrowRight className="size-3.5" />
            </Link>
          }
        >
          {isLoading ? (
            <div className="p-4">
              <TableSkeleton rows={5} columns={7} />
            </div>
          ) : recentOrders.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <EmptyState
                title="No orders yet"
                description="Orders will appear here once synced from your channels."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <OrdersTable orders={recentOrders} currency={orgCurrency} />
            </div>
          )}
        </SectionCard>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <ProductsPanel
            topProducts={dashboard?.topSellingProducts}
            lowStockProducts={dashboard?.lowStockProducts}
            lowStockVariants={dashboard?.lowStockVariants}
            periodLabel={range.label}
            isLoading={isLoading}
            currency={orgCurrency}
            className="flex-1"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The sparkline beside each KPI, drawn from the same series the profit chart
 * below plots — so the line under a card is literally the shape that produced
 * the card's figure, over the same window. Returns undefined while the request
 * is in flight so the chart renders empty rather than briefly plotting a
 * partial series.
 */
function sparklineFor(
  series: SalesProfitPoint[] | undefined,
  metric: "grossSales" | "orders" | "newCustomers",
): SparklinePoint[] | undefined {
  return series?.map((point) => ({ label: point.bucket, value: point[metric] }));
}
