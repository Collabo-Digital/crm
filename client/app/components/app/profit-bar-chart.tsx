import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Link } from "react-router";
import { TrendingUp, TrendingDown, Loader2 } from "lucide-react";
import { useSalesAndProfit } from "~/hooks/use-dashboard-queries";
import { cn, formatCurrency } from "~/lib/utils";
import type { DashboardQueryParams } from "~/types/api";

const SERIES_LABEL: Record<string, string> = {
  netSales: "Net Sales",
  grossProfit: "Gross Profit",
};

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number | null; name: string; dataKey?: string }>;
  label?: string;
  /** The org's reporting currency — every bar is already converted into it. */
  currency: string;
}

function CustomTooltip({ active, payload, label, currency }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-caption shadow-md">
      <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey ?? entry.name} className="text-muted-foreground">
          {SERIES_LABEL[entry.dataKey ?? entry.name] ?? entry.name}:{" "}
          <span className="font-semibold text-popover-foreground">
            {/* A null profit means no cost price was set for anything sold that
                period. Formatting it as a currency would print a confident
                zero for something we simply don't know. */}
            {entry.value === null ? "—" : formatCurrency(entry.value, currency)}
          </span>
        </p>
      ))}
    </div>
  );
}

/** One term in the walk from what customers paid down to gross profit. */
function Term({
  label,
  value,
  currency,
  sign,
}: {
  label: string;
  value: number;
  currency: string;
  sign?: "minus";
}) {
  return (
    <span className="whitespace-nowrap">
      {sign === "minus" && <span className="text-muted-foreground">− </span>}
      <span className="text-muted-foreground">{label} </span>
      <span className="font-medium text-foreground">
        {formatCurrency(value, currency)}
      </span>
    </span>
  );
}

/**
 * Sales and gross profit for the selected window.
 *
 * Takes `params` rather than calling the hook bare: the page reads its stat
 * cards off the same query, and the two only share a React Query cache entry —
 * and therefore only ever show the same numbers — when they pass identical
 * params.
 */
export function ProfitBarChart({
  currency,
  params,
}: {
  currency: string;
  params?: DashboardQueryParams;
}) {
  const { data: sales, isLoading } = useSalesAndProfit(params);

  const chartData = sales?.data ?? [];
  const totals = sales?.totals;
  const grossProfit = totals?.grossProfit ?? null;
  const coverage = totals?.costCoverage ?? 0;
  const hasCostData = coverage > 0;

  // Every figure here is now converted into the org's currency by the server,
  // at each order's own stored rate — so the walk below is a valid single-
  // currency sum again, whatever mix of currencies the orders came in.
  //
  // The one thing that can still make it incomplete is an order whose rate
  // never resolved: those are excluded from the sums rather than counted at
  // 1:1, and saying so is the difference between a total that is smaller than
  // expected and one that is quietly wrong.
  const reportingCurrency = totals?.currency ?? currency;
  const unconvertedOrders = totals?.unconvertedOrders ?? 0;

  // `previous === 0` means there is no comparison period yet — the API reports
  // that as a nominal 100% up, so the badge is hidden rather than presenting
  // growth-from-nothing as a trend.
  const trend = sales?.profitTrend;
  // `change` is null for an unbounded window, where there is no earlier period
  // to trend against — same reason the badge is hidden when `previous` is 0.
  const showTrend =
    !!trend?.change && trend.previous !== 0 && trend.change.direction !== "same";
  const isUp = trend?.change?.direction === "up";

  return (
    <div className="flex h-full flex-col rounded-xl bg-card p-5 shadow-sm ring-1 ring-border">
      <div className="mb-1 flex items-start justify-between gap-3">
        <p className="text-body font-semibold text-foreground">Gross Profit</p>
        {sales && (
          <span className="shrink-0 text-caption text-muted-foreground">
            {sales.period.label}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <p
              className={cn(
                "text-stat",
                hasCostData ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {grossProfit === null
                ? "—"
                : formatCurrency(grossProfit, reportingCurrency)}
            </p>
            {totals?.grossMarginPct != null && (
              <span className="text-caption font-medium text-muted-foreground">
                {totals.grossMarginPct.toFixed(1)}% margin
              </span>
            )}
            {showTrend && (
              <>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-semibold",
                    isUp ? "bg-ink text-brand" : "bg-danger-subtle text-danger"
                  )}
                >
                  {isUp ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                  {trend.change?.percentage}%
                </span>
                <span className="text-caption text-muted-foreground">
                  vs. previous period
                </span>
              </>
            )}
          </div>

          {/* The walk from the Total Sales card down to the figure above it.
              Sales and profit are different numbers for real reasons; printing
              those reasons is what stops the pair looking arbitrary. */}
          {totals && (
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
              <Term label="Sales" value={totals.grossSales} currency={reportingCurrency} />
              <Term label="tax" value={totals.tax} currency={reportingCurrency} sign="minus" />
              <Term label="shipping" value={totals.shipping} currency={reportingCurrency} sign="minus" />
              {totals.refunds > 0 && (
                <Term label="refunds" value={totals.refunds} currency={reportingCurrency} sign="minus" />
              )}
              <span className="whitespace-nowrap">
                <span className="text-muted-foreground">= net sales </span>
                <span className="font-medium text-foreground">
                  {formatCurrency(totals.netSales, reportingCurrency)}
                </span>
              </span>
              {hasCostData && (
                <Term label="COGS" value={totals.cogs} currency={reportingCurrency} sign="minus" />
              )}
              {unconvertedOrders > 0 && (
                <span className="whitespace-nowrap text-warning">
                  excludes {unconvertedOrders} order
                  {unconvertedOrders === 1 ? "" : "s"} with no exchange rate
                </span>
              )}
            </div>
          )}

          {!hasCostData ? (
            <p className="mb-3 text-caption text-muted-foreground">
              No cost prices set, so profit can&apos;t be calculated.{" "}
              <Link to="/products" className="font-medium text-brand-strong hover:underline">
                Add cost prices
              </Link>{" "}
              to your products to see it.
            </p>
          ) : coverage < 1 ? (
            // Never present a partial figure as a whole one. The profit above
            // covers only the items we can price.
            <p className="mb-3 text-caption text-muted-foreground">
              Based on {Math.round(coverage * 100)}% of sales —{" "}
              <Link to="/products" className="font-medium text-brand-strong hover:underline">
                the rest have no cost price set
              </Link>
              .
            </p>
          ) : null}

          <div className="mb-3 flex items-center gap-4 text-caption text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-border" />
              Net Sales
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-brand" />
              Gross Profit
            </span>
          </div>

          {chartData.length > 0 ? (
            <div className="min-h-40 flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barGap={3} barCategoryGap="35%">
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  {/* Gross profit can legitimately be negative once COGS is in
                      the picture, so the axis has to be free to go below zero
                      and the baseline has to be visible when it does. */}
                  <YAxis hide domain={["auto", "auto"]} />
                  <ReferenceLine y={0} stroke="var(--border)" />
                  <Tooltip content={<CustomTooltip currency={reportingCurrency} />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  <Bar dataKey="netSales" fill="var(--border)" radius={[4, 4, 0, 0]} />
                  {/* Recharts skips null, so a month with no cost data draws a
                      sales bar and no profit bar — which is the truth. */}
                  <Bar dataKey="grossProfit" fill="var(--brand)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-caption text-muted-foreground">
              No sales data available yet
            </div>
          )}
        </>
      )}
    </div>
  );
}
