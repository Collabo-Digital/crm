import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency } from "~/lib/utils";

/** Plot plus the x-axis band. The page's loading skeleton is `h-[220px]` to match. */
const POS_DAILY_CHART_HEIGHT = 220;

export interface PosDailyPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  sales: number;
  orders: number;
}

/** "3 Oct", or "Fri, 3 Oct" in the tooltip. Calendar days, so read in UTC. */
function dayLabel(date: string, withWeekday = false): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(withWeekday && { weekday: "short" }),
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Axis ticks: ₹0, ₹2K, ₹1.2L — Indian grouping for rupees, as everywhere else. */
function compactMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : undefined, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return String(value);
  }
}

function DayTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload: PosDailyPoint }>;
  currency: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-caption shadow-md">
      <p className="font-semibold text-popover-foreground tabular-nums">
        {formatCurrency(point.sales, currency)}
      </p>
      <p className="text-muted-foreground">
        {dayLabel(point.date, true)} · {point.orders.toLocaleString()} bill{point.orders === 1 ? "" : "s"}
      </p>
    </div>
  );
}

/**
 * Store sales per day, one column each. Its own file so the report page can
 * lazy-load it: recharts is the largest chunk in the app.
 */
export function PosDailySalesChart({ data, currency }: { data: PosDailyPoint[]; currency: string }) {
  return (
    <ResponsiveContainer width="100%" height={POS_DAILY_CHART_HEIGHT}>
      <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(date: string) => dayLabel(date)}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          minTickGap={12}
        />
        <YAxis
          tickFormatter={(value: number) => compactMoney(value, currency)}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          width={56}
          allowDecimals={false}
        />
        <Tooltip
          content={<DayTooltip currency={currency} />}
          cursor={{ fill: "var(--muted)" }}
          isAnimationActive={false}
        />
        <Bar
          dataKey="sales"
          name="Sales"
          fill="var(--brand-strong)"
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
