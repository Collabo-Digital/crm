import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { DashboardTrendPoint } from "~/services/analytics.service";

/**
 * Rendered height. The page's loading skeleton is `h-[260px]` to match — it
 * can't import this constant without statically pulling recharts back in.
 */
const ANALYTICS_TREND_CHART_HEIGHT = 260;

/**
 * Cart / checkout / orders trend lines for the analytics page.
 *
 * Lives in its own file so the page can lazy-load it: recharts is the largest
 * chunk in the app, and the page shell and its data request should not wait
 * for it.
 */
export function AnalyticsTrendChart({ trend }: { trend: DashboardTrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={ANALYTICS_TREND_CHART_HEIGHT}>
      <LineChart data={trend} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--popover)",
            color: "var(--popover-foreground)",
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="addToCart"
          name="Add to Cart"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
          animationDuration={300}
        />
        <Line
          type="monotone"
          dataKey="reachedCheckout"
          name="Reached Checkout"
          stroke="var(--chart-3)"
          strokeWidth={2}
          dot={false}
          animationDuration={300}
        />
        <Line
          type="monotone"
          dataKey="completedOrders"
          name="Completed Orders"
          stroke="var(--chart-4)"
          strokeWidth={2}
          dot={false}
          animationDuration={300}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
