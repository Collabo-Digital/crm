import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "~/lib/utils";

export interface Snack {
  /** Changes on every message, so the same text twice restarts the timer. */
  id: number;
  text: string;
  tone?: "default" | "warning";
  action?: { label: string; onClick: () => void };
}

const SHOW_MS = 4_000;

/**
 * A short message near the bottom of the till ("Removed Kurta. Undo"). It sits
 * above the bottom bar, never over the Charge button, and goes away by itself.
 */
export function PosSnackbar({ snack, onDismiss, className }: { snack: Snack | null; onDismiss: () => void; className?: string }) {
  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(onDismiss, SHOW_MS);
    return () => clearTimeout(t);
  }, [snack, onDismiss]);

  if (!snack) return null;
  return (
    <div className={cn("pointer-events-none flex justify-center px-3", className)}>
      <div
        key={snack.id}
        role="status"
        className="pointer-events-auto flex min-h-12 w-full max-w-md items-center gap-2 rounded-xl bg-ink py-1.5 pr-1.5 pl-4 text-label text-ink-foreground shadow-lg ring-1 ring-white/10 animate-in fade-in-0 slide-in-from-bottom-2"
      >
        {snack.tone === "warning" && <AlertTriangle className="size-4 shrink-0 text-amber-400" />}
        <span className="min-w-0 flex-1 py-1.5">{snack.text}</span>
        {snack.action && (
          <button
            type="button"
            onClick={() => {
              snack.action!.onClick();
              onDismiss();
            }}
            className="min-h-11 shrink-0 rounded-lg px-3 font-semibold text-brand hover:bg-white/10"
          >
            {snack.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
