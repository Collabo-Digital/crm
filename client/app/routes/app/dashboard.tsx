import { useState } from "react";
import { ArrowRight, Download, Upload, Target, Users, ShoppingBag } from "lucide-react";
import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
  PageHeaderDescription,
  PageHeaderActions,
} from "~/components/ui/page-header";
import { ProfitBarChart } from "~/components/app/profit-bar-chart";
import { SalesDonutChart } from "~/components/app/sales-donut-chart";
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
import { formatCurrency } from "~/lib/utils";
import { StatCard } from "~/components/app/stat-card";
import { MoneyTotal } from "~/components/app/money-total";
import { ProductsPanel } from "~/components/app/products-panel";
import { SectionCard } from "~/components/app/section-card";

export function meta() {
  return [
    { title: "Dashboard | Collabo CRM" },
    { name: "description", content: "Overview of your CRM data" },
  ];
}

const RANGE_OPTIONS: ReadonlyArray<{ value: DashboardRange; label: string }> = [
  { value: "30d", label: "Last 30 days" },
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
];

export default function DashboardPage() {
  // One window for the whole page. Total Sales used to be an all-time figure
  // sitting beside a chart hard-coded to a rolling 12 months, so the two could
  // never be reconciled and neither said which period it covered.
  const [range, setRange] = useState<DashboardRange>("12m");
  const params: DashboardQueryParams = { range };

  const { data: dashboard, isLoading } = useDashboard(params);
  const { exportCsv, exportJson } = useExportDashboard();
  const { data: org } = useCurrentOrg();
  // Same params as the chart below, so React Query serves both from one
  // request and the cards cannot disagree with the bars.
  const { data: sales, isLoading: salesLoading } = useSalesAndProfit(params);
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
            <PageHeaderTitle>Overview</PageHeaderTitle>
            <PageHeaderDescription>
              An overview of recent data of customers info, products details and analysis.
            </PageHeaderDescription>
          </PageHeaderContent>
          <PageHeaderActions>
            <Select value={range} onValueChange={(v) => setRange(v as DashboardRange)}>
              <SelectTrigger className="h-8 w-36 rounded-lg text-caption font-medium shadow-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="action"
              variant="outline"
              onClick={() => exportCsv(params)}
            >
              <Upload className="size-3.5" />
              Export CSV
            </Button>
            <Button
              variant="brand"
              size="action"
              onClick={() => exportJson(params)}
            >
              <Download className="size-3.5" />
              Download Report
            </Button>
          </PageHeaderActions>
        </PageHeader>
      </div>

      {/* Stat cards row */}
      <div className="flex gap-3 ">
        <div className="flex flex-col flex-1 overflow-hidden rounded-lg ring-1 ring-border divide-y divide-border">
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
        <div className="flex flex-col flex-2  overflow-hidden rounded-lg ring-1 ring-border divide-y divide-border">
          <ProfitBarChart currency={orgCurrency} params={params} />
          {/* <SalesDonutChart currency={orgCurrency} /> */}
        </div>
      </div>

      {/* Bottom row — recent orders table and top products */}
      <div className="flex gap-3 justify-between">
        <SectionCard
          className="flex flex-2 flex-col"
          title="Recent Orders"
          description="Keep track of recent order data and others information."
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
              <OrdersTable orders={recentOrders} currency={orgCurrency} variant="compact" />
            </div>
          )}
        </SectionCard>
        <div className="flex flex-1 flex-col gap-4">
          <ProductsPanel
            topProducts={dashboard?.topSellingProducts}
            lowStockProducts={dashboard?.lowStockProducts}
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
