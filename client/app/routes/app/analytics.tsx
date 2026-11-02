import { lazy, Suspense } from "react";
import { oneOf, useSessionState } from "~/hooks/use-session-state";
import { Package, RefreshCw } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatDateTime } from "~/lib/format-date";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { StatCard } from "~/components/app/stat-card";
import {
  useAnalyticsDashboard,
  useRefreshAnalytics,
} from "~/hooks/use-analytics-queries";
import { QueryErrorState } from "~/components/app/query-error-state";
import { useCurrentRole } from "~/hooks/use-current-role";
import type { SparklinePoint } from "~/components/app/chart-line-default";
import type {
  AnalyticsRange,
  AnalyticsChannelFilter,
  DashboardStat,
  DashboardTrendPoint,
} from "~/services/analytics.service";

// Lazy so the page shell renders and the data request starts while the
// recharts chunk is still downloading.
const AnalyticsTrendChart = lazy(() =>
  import("~/components/app/analytics-trend-chart").then((m) => ({
    default: m.AnalyticsTrendChart,
  }))
);

/** Matches the trend chart's rendered height so the card doesn't resize. */
const trendChartSkeleton = <Skeleton className="h-[260px] w-full" />;

export function meta() {
  return [{ title: "Analytics | Collabo CRM" }];
}

/**
 * Pixel-first analytics dashboard.
 *
 * Only the Shopify storefront writes data today, so there is no channel
 * filter: Instagram and WhatsApp options could only ever show nothing. The
 * service still takes a channel for when another pipeline lands.
 */
export default function AnalyticsPage() {
  const [range, setRange] = useSessionState<AnalyticsRange>(
    "analytics.range",
    "7d",
    oneOf(["7d", "30d", "6m", "12m"]),
  );
  const channel: AnalyticsChannelFilter = "all";

  const { data, isLoading, isFetching, isError, isPlaceholderData, refetch } =
    useAnalyticsDashboard({ range, channel });
  const refresh = useRefreshAnalytics();
  // Refreshing calls Shopify and rewrites the figures; the server refuses it to viewers.
  const canRefresh = useCurrentRole().role !== "VIEWER";
  // First load only. A range/channel change keeps the previous data on screen
  // (dimmed via `stale`) rather than going back to skeletons.
  const initialLoading = isLoading && !data;
  const stale = isPlaceholderData && "opacity-50";

  const stats = data?.stats ?? [];
  const trend = data?.trend ?? [];
  const topPages = data?.topPages ?? [];
  const topViewedProducts = data?.topViewedProducts ?? [];
  const topAddedToCart = data?.topAddedToCart ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-page-title text-foreground">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            What shoppers do on your Shopify store: visits, product views, carts and checkouts.
            {data?.meta.lastRefreshedAt ? (
              <span className="ml-2 text-xs">
                · Last refreshed {formatLastRefreshed(data.meta.lastRefreshedAt)}
              </span>
            ) : null}
          </p>
        </div>
        <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:w-auto">
          <Select value={range} onValueChange={(v) => setRange(v as AnalyticsRange)}>
            <SelectTrigger aria-label="Period" className="h-8 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-caption text-muted-foreground shadow-sm sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="6m">Last 6 months</SelectItem>
              <SelectItem value="12m">Last 12 months</SelectItem>
            </SelectContent>
          </Select>
          {canRefresh && (
            <button
              type="button"
              onClick={() => refresh.mutate({ range, channel })}
              disabled={refresh.isPending}
              aria-label="Refresh analytics"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-input bg-card px-3 text-caption font-medium text-foreground shadow-sm hover:bg-muted disabled:opacity-60"
            >
              <RefreshCw className={`size-3.5 ${refresh.isPending ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          )}
        </div>
      </div>

      {/* 1. Basic stats */}
      <div className={cn("grid grid-cols-1 gap-5 rounded-xl bg-card p-3 transition-opacity sm:grid-cols-2 lg:grid-cols-3", stale)}>
        {/* Error and loading guard the whole panel rather than sitting beside
            the mapped stats as extra grid children. That older shape rendered
            completely blank on failure: `stats` fell back to [] so nothing
            mapped, and the placeholder was gated on isLoading, so it
            disappeared too — a broken page and a quiet one looked the same. */}
        {isError && !data ? (
          <div className="col-span-full">
            <QueryErrorState resource="analytics" onRetry={() => refetch()} />
          </div>
        ) : isLoading && stats.length === 0 ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="flex-1">
                <Skeleton className="mb-3 h-3 w-24" />
                <Skeleton className="h-7 w-20" />
              </div>
              {i < 2 && (
                <Separator orientation="vertical" className="hidden h-15 md:block" />
              )}
            </div>
          ))
        ) : (
          stats.map(({ key, label, value, change, changeLabel }, i, all) => (
            <div key={key} className="flex items-center gap-4">
              <StatCard
                variant="inline"
                label={label}
                value={value.toLocaleString()}
                change={change ?? undefined}
                // Fewer abandoned carts is the good news.
                goodWhen={key === "totalAbandonedCarts" ? "down" : "up"}
                changeLabel={change === null ? "None in the previous period" : changeLabel}
                sparklineData={sparklineFor(key, trend)}
                className="flex-1"
              />
              {i < all.length - 1 && (
                <Separator orientation="vertical" className="hidden h-15 md:block" />
              )}
            </div>
          ))
        )}
      </div>

      {/* 2. Top lists */}
      <div className={cn("grid grid-cols-1 gap-4 transition-opacity lg:grid-cols-3", stale)}>
        <TopList
          title="Most Viewed Pages"
          subtitle="Top 5 pages by views in this period"
          isLoading={initialLoading}
          rows={topPages.map((p) => ({
            key: p.path,
            label: p.title || p.path,
            sub: p.title ? p.path : null,
            value: p.views,
            unit: "views",
          }))}
        />
        <TopList
          title="Most Viewed Products"
          subtitle="Top 5 products by unique viewers"
          showImage
          isLoading={initialLoading}
          rows={topViewedProducts.map((p) => ({
            key: p.title,
            label: p.title,
            sub: null,
            value: p.views,
            unit: "views",
            image: p.image,
          }))}
        />
        <TopList
          title="Most Added-to-Cart Products"
          subtitle="Top 5 products by add-to-cart events"
          showImage
          isLoading={initialLoading}
          rows={topAddedToCart.map((p) => ({
            key: p.title,
            label: p.title,
            sub: null,
            value: p.addToCarts,
            unit: "add to cart",
            image: p.image,
          }))}
        />
      </div>

      {/* 3. Trend graph */}
      <div className="rounded-xl bg-white dark:bg-gray-900 p-5 shadow-sm ring-1 ring-border">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Cart, Checkout &amp; Orders Over Time
            </p>
            <p className="text-xs text-muted-foreground">
              {range === "7d"
                ? "Daily trends over the past 7 days"
                : range === "30d"
                ? "Daily trends over the past 30 days"
                : range === "6m"
                  ? "Monthly trends over the past 6 months"
                  : "Monthly trends over the past year"}
            </p>
          </div>
          {isFetching ? (
            <span className="text-xs text-muted-foreground">Updating…</span>
          ) : null}
        </div>
        {initialLoading ? (
          trendChartSkeleton
        ) : (
          <div className={cn("transition-opacity", stale)}>
            <Suspense fallback={trendChartSkeleton}>
              <AnalyticsTrendChart trend={trend} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

function formatLastRefreshed(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - then.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `on ${formatDateTime(iso)}`;
}

/**
 * The sparkline beside each stat, drawn from the same trend series the chart
 * at the bottom of the page plots. `totalAbandonedCarts` has no series of its
 * own, so it is derived as the carts that never reached checkout — clamped,
 * because a period whose checkouts were attributed differently could otherwise
 * plot a negative value.
 */
function sparklineFor(
  key: DashboardStat["key"],
  trend: DashboardTrendPoint[],
): SparklinePoint[] {
  return trend.map((point) => ({
    label: point.label,
    value:
      key === "totalAddToCart"
        ? point.addToCart
        : key === "totalCheckout"
          ? point.reachedCheckout
          : Math.max(0, point.addToCart - point.reachedCheckout),
  }));
}

interface TopListRow {
  key: string;
  label: string;
  sub: string | null;
  value: number;
  unit: string;
  image?: string | null;
}

function TopList({
  title,
  subtitle,
  rows,
  showImage = false,
  isLoading = false,
}: {
  title: string;
  subtitle: string;
  rows: TopListRow[];
  /** Product lists: a thumbnail per row so the merchant recognises the product. */
  showImage?: boolean;
  /**
   * First load. Without it the list showed its "No data" message while the
   * request was still in flight, so loading and empty looked identical.
   */
  isLoading?: boolean;
}) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border overflow-hidden">
      <div className="px-5 py-4 border-b">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="divide-y divide-border">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3">
              {showImage ? <Skeleton className="size-9 shrink-0 rounded-md" /> : null}
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-10 shrink-0" />
            </div>
          ))
        ) : rows.length === 0 ? (
          <div className="px-5 py-6 text-xs text-muted-foreground">
            No data for this period yet. It appears once shoppers visit your
            Shopify store; Collabo updates it every hour, or press Refresh.
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.key} className="flex items-center gap-3 px-5 py-3">
              {showImage ? (
                <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                  {row.image ? (
                    <img src={row.image} alt="" className="size-full object-cover" loading="lazy" />
                  ) : (
                    <Package className="size-4 text-muted-foreground" />
                  )}
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">
                  {row.label}
                </p>
                {row.sub ? (
                  <p className="truncate text-xs text-muted-foreground">{row.sub}</p>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {row.value.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">{row.unit}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
