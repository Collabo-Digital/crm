import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

import { cn } from "~/lib/utils";

export type PendingChange = {
  id: string;
  label: string;
  value: string;
  undo: () => void;
};

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const BUTTON =
  "flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition-colors hover:bg-white/10 active:translate-y-px disabled:pointer-events-none disabled:opacity-50";
const PRIMARY =
  "flex h-[34px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-[#CEF17B] px-4 text-[13px] font-semibold text-[#171717] transition-colors hover:bg-[#BADE6F] active:translate-y-px disabled:opacity-60";

/**
 * The product page's only Save. Every editable field on every tab reports
 * here, so a change made anywhere is visible — and saved — from anywhere.
 * Layout follows the "Floating Save Pill" design.
 */
export function ProductSavePill({
  changes,
  isSaving,
  canSync,
  syncOnSave,
  onToggleSync,
  onSave,
  onDiscard,
  afterSave,
  isSyncing,
  onSyncNow,
  onDismissAfterSave,
}: {
  changes: PendingChange[];
  isSaving: boolean;
  /** The product is already on Shopify. The toggle is hidden otherwise. */
  canSync: boolean;
  syncOnSave: boolean;
  onToggleSync: () => void;
  onSave: () => void;
  onDiscard: () => void;
  /** Saved but not pushed: offer the push. */
  afterSave: boolean;
  isSyncing: boolean;
  onSyncNow: () => void;
  onDismissAfterSave: () => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const dirty = changes.length > 0;
  // Closed again once everything is saved or discarded, so the next edit
  // doesn't pop the old list back open.
  useEffect(() => {
    if (!dirty) setListOpen(false);
  }, [dirty]);
  if (!dirty && !isSaving && !afterSave) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[var(--mobile-nav-height)] z-40 flex justify-center px-4 pb-3 md:bottom-0 md:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto flex max-w-full flex-col items-center gap-2">
        {dirty && listOpen && (
          <ul
            id="pending-changes"
            className="max-h-64 w-[min(340px,calc(100vw-2rem))] overflow-y-auto rounded-[14px] bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10 dark:ring-white/15"
          >
            {changes.map((change) => (
              <li
                key={change.id}
                className="flex items-center gap-2.5 px-2 py-1.5 text-[13px]"
              >
                <span className="w-[90px] shrink-0 truncate text-muted-foreground">
                  {change.label}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium" title={change.value}>
                  {change.value}
                </span>
                <button
                  type="button"
                  onClick={change.undo}
                  disabled={isSaving}
                  className="text-xs font-medium text-[#084734] disabled:opacity-50 dark:text-[#CEF17B]"
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        )}

        <div
          role="region"
          aria-label="Save changes"
          className="flex max-w-full items-center gap-1.5 overflow-x-auto rounded-full bg-[oklch(0.145_0_0/0.92)] p-1.5 text-white shadow-[0_10px_15px_-3px_rgb(0_0_0/0.08),0_4px_6px_-4px_rgb(0_0_0/0.05)] dark:bg-gray-800 dark:ring-1 dark:ring-white/10"
        >
          {dirty || isSaving ? (
            <>
              <button
                type="button"
                className={BUTTON}
                aria-expanded={listOpen}
                aria-controls="pending-changes"
                onClick={() => setListOpen((open) => !open)}
              >
                <span className="size-[7px] rounded-full bg-[#CEF17B]" />
                {/* Short on phones so Save never scrolls out of the pill. */}
                <span>
                  {changes.length}
                  <span className="hidden sm:inline"> unsaved</span>
                  {changes.length === 1 ? " change" : " changes"}
                </span>
                {listOpen ? (
                  <ChevronDown className="size-[13px]" />
                ) : (
                  <ChevronUp className="size-[13px]" />
                )}
              </button>
              <span className="h-5 w-px shrink-0 bg-white/[0.18]" />
              <button
                type="button"
                className={BUTTON}
                onClick={onDiscard}
                disabled={isSaving}
              >
                Discard
              </button>
              {canSync && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={syncOnSave}
                  aria-label="Sync to Shopify when saving"
                  className={BUTTON}
                  onClick={onToggleSync}
                  disabled={isSaving}
                >
                  <span
                    className={cn(
                      "flex h-4 w-7 rounded-full p-0.5 transition-colors",
                      syncOnSave ? "bg-[#CEF17B]" : "bg-white/25",
                    )}
                  >
                    <i
                      className={cn(
                        "size-3 rounded-full bg-white transition-transform",
                        syncOnSave && "translate-x-3",
                      )}
                    />
                  </span>
                  <span className="hidden sm:inline">Shopify</span>
                </button>
              )}
              <button
                type="button"
                className={PRIMARY}
                onClick={onSave}
                disabled={isSaving}
              >
                {isSaving && <Loader2 className="size-3.5 animate-spin" />}
                {isSaving
                  ? "Saving…"
                  : canSync && syncOnSave
                    ? "Save & sync"
                    : "Save"}
                {!isSaving && (
                  <kbd className="hidden rounded-[5px] bg-[#084734]/[0.14] px-[5px] py-px font-sans text-[11px] font-medium text-[#084734] sm:inline">
                    {isMac ? "⌘S" : "Ctrl S"}
                  </kbd>
                )}
              </button>
            </>
          ) : (
            <>
              <span className="flex h-[34px] items-center gap-2 whitespace-nowrap pl-3.5 pr-3 text-[13px] font-medium">
                <Check className="size-3.5 text-[#CEF17B]" strokeWidth={2.4} />
                {isSyncing ? (
                  "Syncing to Shopify…"
                ) : (
                  <span>
                    <span className="hidden sm:inline">Saved to Collabo · </span>
                    Shopify not updated
                  </span>
                )}
              </span>
              <button
                type="button"
                className={BUTTON}
                onClick={onDismissAfterSave}
                disabled={isSyncing}
              >
                Not now
              </button>
              <button
                type="button"
                className={PRIMARY}
                onClick={onSyncNow}
                disabled={isSyncing}
              >
                {isSyncing && <Loader2 className="size-3.5 animate-spin" />}
                Sync<span className="hidden sm:inline"> to Shopify</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
