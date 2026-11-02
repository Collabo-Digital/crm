import type { StatusTone } from "./status-tone.ts";

/**
 * Which way is good news for a figure. Sales and new customers are better up;
 * pending orders and abandoned carts are better down; tax collected is
 * neither, it only follows sales.
 */
export type TrendGoodWhen = "up" | "down" | "neither";

export interface TrendBadge {
  direction: "up" | "down" | "flat";
  tone: StatusTone;
  /** What the badge prints: "12%", "1,133%". */
  text: string;
  /** What a screen reader hears: "Up 700%, worse than the previous period". */
  label: string;
}

/**
 * The trend badge for a signed percent change. Every change of zero or more
 * used to get the same dark "up" badge, so "0%" read as growth and
 * "Pending Orders ↗700%" looked like good news. Now a flat change is neutral,
 * and the colour says whether the move is good for this figure.
 */
export function trendBadge(change: number, goodWhen: TrendGoodWhen = "up"): TrendBadge {
  const pct = Math.abs(Math.round(change));
  if (pct === 0) return { direction: "flat", tone: "neutral", text: "0%", label: "No change on the previous period" };
  const direction = change > 0 ? "up" : "down";
  const text = `${pct.toLocaleString("en-IN")}%`;
  const verdict =
    goodWhen === "neither" ? "" : direction === goodWhen ? ", better than the previous period" : ", worse than the previous period";
  return {
    direction,
    tone: goodWhen === "neither" ? "neutral" : direction === goodWhen ? "success" : "critical",
    text,
    label: `${direction === "up" ? "Up" : "Down"} ${text}${verdict}`,
  };
}

/** The server's comparison block on a stat: the change, or null when there was no earlier period. */
export interface ComparedMetric {
  previous: number | string;
  change: { percentage: number; direction: "up" | "down" | "same" } | null;
}

/**
 * The signed change to show, or undefined when there is no fair one. A
 * previous period with nothing in it makes any rise "100%" (the server's
 * placeholder) or an absurd multiple, so no percentage is shown at all.
 */
export function comparedChange(metric: ComparedMetric): number | undefined {
  if (!metric.change || Number(metric.previous) === 0) return undefined;
  return metric.change.direction === "down" ? -metric.change.percentage : metric.change.percentage;
}

/** The line under the figure: what the badge compares against, or why there is no badge. */
export function comparedLabel(metric: ComparedMetric, against = "vs previous period"): string | undefined {
  if (!metric.change) return undefined;
  return comparedChange(metric) === undefined ? "None in the previous period" : against;
}
