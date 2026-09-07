import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, TrendingUp, TrendingDown } from "lucide-react";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { ChartLineDefault, type SparklinePoint } from "./chart-line-default";

interface StatCardProps {
    label: string;
    /**
     * Undefined renders an em dash — callers pass undefined while loading.
     * A node rather than a string so a money total spanning several currencies
     * can stack one line per currency (see `MoneyTotal`).
     */
    value?: ReactNode;
    /**
     * Omit when there is no trend to show — a failed request, or a metric with
     * no comparison period. Callers used to pass 0 in that case, which rendered
     * a GREEN up-trend "0%" badge (`change >= 0` is true for zero), so a failed
     * stats request looked like four healthy metrics.
     */
    change?: number;
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
    const hasTrend = change !== undefined;
    const isPositive = (change ?? 0) >= 0;
    const isInverted = tone === "inverted";

    const trendBadge = hasTrend && (
        <span
            className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-caption font-semibold",
                isPositive ? "bg-ink text-brand" : "bg-danger-subtle text-danger",
                // The default positive badge is ink-on-lime, which disappears
                // against an inverted card.
                isInverted && isPositive && "bg-brand text-brand-foreground"
            )}
        >
            {isPositive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {Math.abs(change!)}%
        </span>
    );

    if (variant === "inline") {
        return (
            <div className={cn("", className)}>
                <div className="flex items-center gap-3">
                    <div className="flex flex-1 flex-col gap-2">
                        <div className="flex items-center gap-3">
                            <p className="text-body font-medium text-muted-foreground">{label}</p>
                            {/* {icon && <div className={iconChip}>{icon}</div>} */}
                        </div>
                        <div className="flex items-center gap-3">
                            <p className="text-subhead text-foreground">{value ?? "—"}</p>
                            {trendBadge}
                        </div>
                    </div>
                    <div className="w-full flex-1">
                        <ChartLineDefault data={sparklineData} />
                    </div>
                </div>
                {changeLabel && (
                    <p className="mt-1.5 text-caption text-muted-foreground">{changeLabel}</p>
                )}
            </div>
        );
    }

    return (
        <div
            className={cn(
                "bg-card p-5 shadow-sm ring-1 ring-border",
                isInverted && "bg-ink ring-ink",
                className
            )}
        >
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-2 flex-col gap-3">
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
                        {trendBadge}
                    </div>
                </div>

                {sparkline && (
                    <div className="w-full flex-2">
                        <ChartLineDefault variant="area" tone="brand" data={sparklineData} />
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
