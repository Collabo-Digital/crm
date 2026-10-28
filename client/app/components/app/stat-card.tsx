import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, Minus, TrendingUp, TrendingDown } from "lucide-react";

import { Skeleton } from "~/components/ui/skeleton";
import { STATUS_TONE_CLASSES } from "~/lib/status-tone";
import { trendBadge, type TrendGoodWhen } from "~/lib/trend";
import { cn } from "~/lib/utils";
import type { SparklinePoint } from "./chart-line-default";

// Lazy on purpose: a static import here put all of recharts into the chunk of
// every route that renders a StatCard — most of which never draw a sparkline.
const ChartLineDefault = lazy(() =>
    import("./chart-line-default").then((m) => ({ default: m.ChartLineDefault }))
);

/** Same box the sparkline reserves when it has no data, so nothing shifts. */
const sparklineFallback = <div className="h-16 w-full" aria-hidden />;

/**
 * Without a series the chart would only draw that empty box, so the chunk is
 * not requested at all — a card with nothing to plot never downloads recharts.
 */
function Sparkline(props: {
    data?: SparklinePoint[];
    variant?: "line" | "area";
    tone?: "brand";
}) {
    if (!props.data?.length) return sparklineFallback;
    return (
        <Suspense fallback={sparklineFallback}>
            <ChartLineDefault {...props} />
        </Suspense>
    );
}

interface StatCardProps {
    label: string;
    /**
     * Undefined renders an em dash — callers pass undefined while loading.
     * A node rather than a string so a money total spanning several currencies
     * can stack one line per currency (see `MoneyTotal`).
     */
    value?: ReactNode;
    /**
     * Signed percent change on the previous period. Omit when there is no
     * trend to show — a failed request, or no comparison period. Zero renders
     * a neutral "0%", never a rise.
     */
    change?: number;
    /**
     * Which way is good news, which decides the badge colour: a rise in sales
     * is green, a rise in pending orders red. Defaults to "up".
     */
    goodWhen?: TrendGoodWhen;
    changeLabel?: string;
    /** Renders a footer link instead of a trend badge. */
    linkTo?: string;
    linkLabel?: string;
    className?: string;
    icon?: ReactNode;
    isLoading?: boolean;
    /**
     * Renders a sparkline beside the value. Off by default — five routes use
     * this card and only the dashboard wants a chart in it.
     */
    sparkline?: boolean;
    /**
     * Series for the sparkline. Without it the chart area renders empty rather
     * than inventing a curve, so a card with no series — or one still fetching —
     * shows nothing instead of a plausible-looking fake.
     */
    sparklineData?: SparklinePoint[];
    /**
     * "card" — standalone card for Orders / Customers / Analytics (default).
     * "inline" — compact strip layout with sparkline for Products.
     */
    variant?: "card" | "inline";
    /**
     * "inverted" fills the card with `ink` for a bottom-line figure that should
     * outrank the cards beside it. `variant="card"` only.
     */
    tone?: "default" | "inverted";
}

const iconChip =
    "flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground";

/** Displays a single KPI metric with its current value, trend percentage or link, and optional icon. */
export function StatCard({
    label,
    value,
    change,
    goodWhen = "up",
    changeLabel,
    linkTo,
    linkLabel,
    className,
    icon,
    isLoading,
    sparkline = false,
    sparklineData,
    variant = "card",
    tone = "default",
}: StatCardProps) {
    const isInverted = tone === "inverted";
    const trend = change === undefined ? null : trendBadge(change, goodWhen);
    const TrendIcon =
        trend?.direction === "up" ? TrendingUp : trend?.direction === "down" ? TrendingDown : Minus;

    // Status colours, not the brand: lime is not a status, and the old ink
    // "up" badge read as good news whatever the figure measured.
    const trendEl = trend && (
        <span
            className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-caption font-semibold",
                STATUS_TONE_CLASSES[trend.tone]
            )}
        >
            <TrendIcon aria-hidden className="size-3" />
            <span aria-hidden>{trend.text}</span>
            <span className="sr-only">{trend.label}</span>
        </span>
    );

    if (variant === "inline") {
        return (
            <div data-slot="stat-card" className={cn("min-w-0", className)}>
                <div className="flex items-center gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex items-center gap-3">
                            <p className="text-body font-medium text-muted-foreground">{label}</p>
                            {/* {icon && <div className={iconChip}>{icon}</div>} */}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-subhead text-foreground">{value ?? "—"}</p>
                            {trendEl}
                        </div>
                    </div>
                    {Boolean(sparklineData?.length) && <div className="min-w-0 flex-1">
                        <Sparkline data={sparklineData} />
                    </div>}
                </div>
                {changeLabel && (
                    <p className="mt-1.5 text-caption text-muted-foreground">{changeLabel}</p>
                )}
            </div>
        );
    }

    return (
        <div
            data-slot="stat-card"
            className={cn(
                "min-w-0 rounded-xl bg-card p-4 md:p-5 shadow-sm ring-1 ring-border",
                isInverted && "bg-ink ring-ink",
                className
            )}
        >
            <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-2 flex-col gap-3">
                    <div className="flex items-start justify-between gap-2">
                        <p
                            className={cn(
                                "text-body font-medium",
                                isInverted ? "text-ink-foreground/70" : "text-muted-foreground"
                            )}
                        >
                            {label}
                        </p>
                        {/* {icon && <div className={iconChip}>{icon}</div>} */}
                    </div>

                    <div className="flex items-end justify-between gap-3">
                        {isLoading ? (
                            <Skeleton className="h-7 w-24" />
                        ) : (
                            <p
                                className={cn(
                                    "text-stat",
                                    isInverted ? "text-ink-foreground" : "text-foreground"
                                )}
                            >
                                {value ?? "—"}
                            </p>
                        )}
                        {trendEl}
                    </div>
                </div>

                {sparkline && (
                    <div className="w-full flex-2">
                        <Sparkline variant="area" tone="brand" data={sparklineData} />
                    </div>
                )}
            </div>

            {changeLabel && (
                <p
                    className={cn(
                        "mt-1.5 text-caption",
                        isInverted ? "text-ink-foreground/70" : "text-muted-foreground"
                    )}
                >
                    {changeLabel}
                </p>
            )}

            {/* {linkTo && linkLabel && (
                <Link
                    to={linkTo}
                    className="mt-4 flex items-center gap-1 text-caption font-medium text-brand-strong hover:text-brand-strong-hover"
                >
                    {linkLabel} <ArrowRight className="size-3" />
                </Link>
            )} */}
        </div>
    );
}
