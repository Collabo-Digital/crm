import { AlertTriangle, Check, Cloud, CloudOff, Loader2 } from "lucide-react";
import type { ShopifySyncState, ShopifySyncSummary } from "~/lib/shopify-sync";
import { toneClasses } from "~/lib/status-tone";

/**
 * A table's Shopify column: a status pill with a one-line reason under it.
 * Shared by the products and orders tables. The matching row button lives
 * with the row actions, so this cell is display only; the row computes the
 * summary once and hands it to both.
 */

const PILL_CLASS = toneClasses<ShopifySyncState>({
  synced: "success",
  out_of_sync: "attention",
  syncing: "info",
  failed: "critical",
  stuck: "attention",
  not_on_shopify: "neutral",
  // Neutral on purpose: green over "not pushed yet" read as a contradiction.
  unstamped: "neutral",
});

function PillIcon({ state }: { state: ShopifySyncState }) {
  switch (state) {
    case "synced":
      return <Check className="size-3" />;
    case "syncing":
      return <Loader2 className="size-3 animate-spin" />;
    case "not_on_shopify":
      return <CloudOff className="size-3" />;
    case "unstamped":
      return <Cloud className="size-3" />;
    default:
      return <AlertTriangle className="size-3" />;
  }
}

/** Whether someone has to act on it; a phone card shows the sync line only then. */
export function syncNeedsAttention(summary: ShopifySyncSummary<string>): boolean {
  return summary.state === "failed" || summary.state === "stuck" || summary.state === "out_of_sync";
}

export function ShopifySyncCell({
  summary,
  title,
}: {
  summary: ShopifySyncSummary<string>;
  /** Hover text for the pill, e.g. the remote Shopify id. */
  title?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <span
        title={title}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${PILL_CLASS[summary.state]}`}
      >
        <PillIcon state={summary.state} />
        {summary.label}
      </span>
      {/* `truncate` keeps the cell at least as wide as a short reason, so
          "Synced 2h ago" is never cut; a failure message can be a sentence,
          so it is capped and shown whole on hover. */}
      <span title={summary.reason} className="max-w-56 truncate text-caption text-muted-foreground">
        {summary.reason}
      </span>
    </div>
  );
}
