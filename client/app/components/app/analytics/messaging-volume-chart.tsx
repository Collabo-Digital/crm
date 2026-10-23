import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * Messages in and out per day. Two series of the same unit on one axis.
 *
 * Colours are slots 1 and 2 of the validated categorical palette, stepped for
 * the light card (#ffffff) and the dark card (#101828); both pass the
 * lightness, chroma, colour-blind separation and 3:1 contrast checks. Lines
 * are 2px, the grid is a solid hairline, and the newest point carries an end
 * dot with a ring in the card colour and a direct label.
 *
 * Its own file so the page can lazy-load recharts.
 */

export const CHART_HEIGHT = 260;
const MARGIN = { top: 12, right: 52, bottom: 0, left: 0 };
const X_AXIS_HEIGHT = 28;
const LABEL_MIN_GAP_PX = 14;

/** Series colours as CSS variables, switched for dark mode. */
export const VIZ_COLORS = "[--viz-1:#2a78d6] [--viz-2:#eb6834] dark:[--viz-1:#3987e5] dark:[--viz-2:#d95926]";

export const SERIES = [
  { key: "inbound", label: "Messages in", short: "In", color: "var(--viz-1)" },
  { key: "outbound", label: "Messages out", short: "Out", color: "var(--viz-2)" },
] as const;

type Day = { day: string; inbound: number; outbound: number };

const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
};

const compact = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));

/**
 * Clean whole-number ticks: pick the step first (1, 2 or 5 × 10^n, about five
 * intervals), then round the top up to it. A known top also lets the end
 * labels' positions be worked out.
 */
export function niceTicks(max: number): number[] {
  const raw = Math.max(1, max) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((f) => f * magnitude).find((c) => c >= raw) ?? 10 * magnitude);
  const top = Math.max(step, Math.ceil(Math.max(1, max) / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

function VolumeTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey?: unknown; value?: unknown }>; label?: unknown }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-caption text-popover-foreground shadow-md">
      <p className="mb-1 text-micro text-muted-foreground">{dayLabel(String(label))}</p>
      {SERIES.map((s) => (
        <div key={s.key} className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
          <span className="font-semibold tabular-nums">{String(payload.find((p) => p.dataKey === s.key)?.value ?? 0)}</span>
          <span className="text-muted-foreground">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

export function MessagingVolumeChart({ daily }: { daily: Day[] }) {
  const ticks = niceTicks(Math.max(0, ...daily.flatMap((d) => [d.inbound, d.outbound])));
  const max = ticks[ticks.length - 1];
  const last = daily[daily.length - 1];
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom - X_AXIS_HEIGHT;
  // End labels only when the two line ends are far enough apart; otherwise the legend and tooltip carry them.
  const endGap = last ? (Math.abs(last.inbound - last.outbound) / max) * plotHeight : 0;
  const showEndLabels = !!last && endGap >= LABEL_MIN_GAP_PX;
  const lastIndex = daily.length - 1;

  const endDot = (color: string) =>
    function EndDot(props: { cx?: number; cy?: number; index?: number }) {
      if (props.index !== lastIndex || props.cx === undefined || props.cy === undefined) return <g key={props.index} />;
      return <circle key={props.index} cx={props.cx} cy={props.cy} r={4} fill={color} stroke="var(--card)" strokeWidth={2} />;
    };
  const endLabel = (short: string) =>
    function EndLabel(props: { x?: number | string; y?: number | string; index?: number; value?: unknown }) {
      if (!showEndLabels || props.index !== lastIndex) return <g key={props.index} />;
      return (
        <text key={props.index} x={Number(props.x) + 9} y={Number(props.y)} dy={4} className="fill-foreground text-[11px]">
          {short} {String(props.value)}
        </text>
      );
    };

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <LineChart data={daily} margin={MARGIN} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
        <XAxis
          dataKey="day"
          tickFormatter={dayLabel}
          height={X_AXIS_HEIGHT}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          minTickGap={24}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[0, max]}
          ticks={ticks}
          allowDecimals={false}
          tickFormatter={compact}
          width={36}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip content={<VolumeTooltip />} cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }} isAnimationActive={false} />
        {SERIES.map((s) => (
          <Line
            key={s.key}
            // Daily counts are discrete: straight segments, no smoothing that implies values between days.
            type="linear"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={endDot(s.color)}
            activeDot={{ r: 4, fill: s.color, stroke: "var(--card)", strokeWidth: 2 }}
            label={endLabel(s.short)}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
