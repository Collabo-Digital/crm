import { AlertTriangle, Check, Cloud, CloudOff, Loader2 } from "lucide-react";
import type { ShopifySyncState, ShopifySyncSummary } from "~/lib/shopify-sync";

/**
 * A table's Shopify column: a status pill with a one-line reason under it.
 * Shared by the products and orders tables. The matching row button lives
 * with the row actions, so this cell is display only; the row computes the
 * summary once and hands it to both.
 */

const PILL_CLASS: Record<ShopifySyncState, string> = {
  synced: "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  out_of_sync: "bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  syncing: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  failed: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  stuck: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  not_on_shopify: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  // Neutral on purpose: green over "not pushed yet" read as a contradiction.
  unstamped: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

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
      <span title={summary.reason} className="max-w-56 truncate text-[11px] text-muted-foreground">
        {summary.reason}
      </span>
    </div>
  );
}
