"use client"

import * as React from "react"
import { Area, AreaChart, Line, LineChart, XAxis } from "recharts"

import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "~/components/ui/chart"
import { cn } from "~/lib/utils"

/** One point of a series. Without `data` the component renders nothing. */
export interface SparklinePoint {
    label: string
    value: number
}

/**
 * Approved chart tones. Add a case here rather than passing a raw color.
 * `brand` draws in --chart-1 (forest on light, lime on dark): lime itself is
 * 1.3:1 on a white card, too faint for a line.
 */
const CHART_TONE = {
    brand: "var(--chart-1)",
    forest: "var(--brand-forest)",
    success: "var(--success)",
    warning: "var(--warning)",
    danger: "var(--danger)",
    info: "var(--info)",
    neutral: "var(--muted-foreground)",
} as const

export type ChartTone = keyof typeof CHART_TONE

/**
 * Tooltip body: the point's label as the heading, the number under it.
 *
 * `formatter` replaces the whole row rather than just blanking the series name.
 * Leaving the name out via an empty config label does not work — the name span
 * still participates in the row's `justify-between`, which strands the number
 * against the right edge of the card.
 *
 * Recharts clones this element with `active` / `payload` / `label`, so the props
 * have to be spread straight through.
 */
function SparklineTooltip(props: React.ComponentProps<typeof ChartTooltipContent>) {
    return (
        <ChartTooltipContent
            {...props}
            formatter={(value) => (
                <span className="font-mono font-medium tabular-nums text-foreground">
                    {typeof value === "number" ? value.toLocaleString() : String(value)}
                </span>
            )}
        />
    )
}

export function ChartLineDefault({
    tone = "brand",
    variant = "line",
    className,
    data,
}: {
    tone?: ChartTone
    variant?: "line" | "area"
    className?: string
    /** The series to plot. Nothing renders without it — see below. */
    data?: SparklinePoint[]
}) {
    // useId() emits colons, which are invalid in SVG url(#...) references.
    const gradientId = `fill-${React.useId().replace(/:/g, "")}`

    const chartConfig = {
        // The key is load-bearing: ChartStyle emits `--color-<key>` from it, and
        // the stroke and gradient below reference `var(--color-value)` — rename
        // one and you have to rename all of them or the colour silently drops.
        // No `label`: the tooltip shows the point's own label and its number, and
        // the metric name is already on the card beside this chart.
        value: { color: CHART_TONE[tone] },
    } satisfies ChartConfig

    // No normalisation needed — SparklinePoint's own `label`/`value` fields are
    // exactly what the axis and the config key below reference.
    const series = data

    // No data means no chart. There used to be a hardcoded Jan–Jun series here
    // as a fallback, which meant every caller that had nothing to plot — and
    // every caller mid-fetch — drew the same invented curve as if it were real.
    // The reserved box keeps the surrounding card from resizing when the real
    // series lands.
    if (!series?.length) {
        return <div className={cn("h-16 w-full", className)} aria-hidden />
    }

    // All four sides have to be given explicitly. Recharts replaces this object
    // wholesale rather than merging it with its own {top:5,right:5,bottom:5,left:5}
    // default (`resolveDefaultProps` only fills keys that are undefined), then
    // coerces every side you leave out to 0 (`layoutSlice.setMargin`). With top
    // and bottom at 0 the plot area is the full 64px, so the 2px stroke at the
    // highest point is centred on y=0 and its upper half falls outside the SVG.
    const margin = { top: 4, right: 12, bottom: 4, left: 12 }

    return (
        <ChartContainer
            config={chartConfig}
            className={cn("aspect-auto h-16 w-full", className)}
            // Defaults to 320×200, which on the first client frame (ssr is off,
            // so this renders before the ResizeObserver fires) draws a 200px-tall
            // SVG inside a 64px box — it spills and gets clipped by the ancestor
            // overflow-hidden. Matching the real box keeps that frame stable.
            initialDimension={{ width: 160, height: 64 }}
        >
            {variant === "area" ? (
                <AreaChart accessibilityLayer data={series} margin={margin}>
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.35} />
                            <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <XAxis dataKey="label" hide />
                    <ChartTooltip cursor={false} content={<SparklineTooltip />} />
                    <Area
                        dataKey="value"
                        // monotone, not natural: a natural cubic spline overshoots
                        // past the data extremes between points, and there is only
                        // 4px of headroom for it to overshoot into.
                        type="monotone"
                        stroke="var(--color-value)"
                        strokeWidth={2}
                        fill={`url(#${gradientId})`}
                        // Recharts' default is a 1.5s draw-in, replayed on every
                        // range change — on a sparkline that reads as slowness.
                        isAnimationActive={false}
                    />
                </AreaChart>
            ) : (
                <LineChart accessibilityLayer data={series} margin={margin}>
                    <XAxis dataKey="label" hide />
                    <ChartTooltip cursor={false} content={<SparklineTooltip />} />
                    <Line
                        dataKey="value"
                        type="monotone"
                        stroke="var(--color-value)"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                    />
                </LineChart>
            )}
        </ChartContainer>
    )
}