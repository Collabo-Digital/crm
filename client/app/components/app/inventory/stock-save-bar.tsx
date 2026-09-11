import { Check, Pencil, TriangleAlert } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export interface PendingChange {
  stockLineId: string;
  variantId: string;
  product: string;
  variant: string | null;
  from: number;
  to: number;
}

/**
 * Confirms a screenful of edits before any of them is written.
 *
 * Two things it must always say: how many quantities are about to change, and
 * which location they belong to. Merchants work several locations from one
 * screen, and an edit that silently landed on the wrong one is the failure this
 * whole redesign exists to prevent.
 */
export function StockSaveBar({
  changes,
  locationName,
  reviewOpen,
  onToggleReview,
  onRevert,
  onDiscard,
  onSave,
  saving,
  error,
}: {
  changes: PendingChange[];
  locationName: string;
  reviewOpen: boolean;
  onToggleReview: () => void;
  onRevert: (stockLineId: string) => void;
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}) {
  if (changes.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-6 pb-4">
      <div className="pointer-events-auto w-full max-w-4xl">
        {reviewOpen && (
          <div className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-border bg-card p-3 shadow-lg">
            <p className="mb-2 text-micro font-medium uppercase tracking-wide text-muted-foreground">
              Pending at {locationName}
            </p>
            {changes.map((c) => (
              <div
                key={c.stockLineId}
                className="flex items-center gap-3 border-b border-border py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-label text-foreground">
                  {c.product}
                  {c.variant && (
                    <span className="ml-1.5 text-muted-foreground">{c.variant}</span>
                  )}
                </span>
                <span className="text-caption tabular-nums text-muted-foreground line-through">
                  {c.from}
                </span>
                <span className="min-w-8 text-right text-label font-semibold tabular-nums text-foreground">
                  {c.to}
                </span>
                <button
                  type="button"
                  onClick={() => onRevert(c.stockLineId)}
                  className="text-caption text-brand-strong underline underline-offset-2 hover:no-underline"
                >
                  Revert
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-ink px-4 py-3 shadow-lg">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-brand-forest">
            <Pencil className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-label font-semibold text-ink-foreground">
              {changes.length === 1
                ? "1 quantity changed"
                : `${changes.length} quantities changed`}{" "}
              at {locationName}
            </p>
            <p className="text-caption text-ink-foreground/70">
              Other locations are unchanged.
            </p>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggleReview}
            aria-expanded={reviewOpen}
            className="border border-white/20 text-ink-foreground hover:bg-white/10"
          >
            {reviewOpen ? "Hide" : "Review"}
          </Button>

          {error && (
            <span
              className={cn(
                "flex items-center gap-1.5 text-caption text-danger",
                "max-w-sm",
              )}
            >
              <TriangleAlert className="size-3.5 shrink-0" />
              {error}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDiscard}
              disabled={saving}
              className="text-ink-foreground hover:bg-white/10"
            >
              Discard
            </Button>
            <Button
              type="button"
              variant="brand"
              size="sm"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? (
                "Saving…"
              ) : (
                <>
                  <Check className="size-3.5" /> Save changes
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
