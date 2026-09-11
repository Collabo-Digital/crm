import { useState } from "react";
import {
  Archive,
  Barcode,
  CheckCheck,
  Loader2,
  SlidersHorizontal,
  Tag,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  useBulkAddTagsMutation,
  useBulkArchiveMutation,
  useBulkDeleteMutation,
  useBulkRemoveTagsMutation,
  useBulkSetStatusMutation,
  useBulkSyncMutation,
} from "~/hooks/use-product-mutations";
import {
  useGenerateBarcodesMutation,
  useGenerateSkusMutation,
} from "~/hooks/use-inventory-mutations";
import type { Product, ProductStatus } from "~/types/api";
import { Tip } from "~/components/ui/tooltip";

/**
 * Sticky action bar shown above the products table when one or more rows are
 * selected. Provides bulk archive / delete / status / tag / sync actions.
 *
 * Both MANUAL and SHOPIFY-channel products are now editable — the prior
 * "read-only" carve-out for synced products was removed. Bulk actions touch
 * every selected product; the only "skipped" reason left is "Not found".
 */
export function BulkActionBar({
  selectedProducts,
  offPageCount = 0,
  onClear,
}: {
  selectedProducts: Product[];
  /** How many of the selected products are on OTHER pages of the list. */
  offPageCount?: number;
  onClear: () => void;
}) {
  const ids = selectedProducts.map((p) => p.id);
  const editableCount = ids.length;
  const archivedCount = selectedProducts.filter(
    (p) => p.status === "ARCHIVED",
  ).length;

  const archive = useBulkArchiveMutation();
  const setStatus = useBulkSetStatusMutation();
  const addTags = useBulkAddTagsMutation();
  const removeTags = useBulkRemoveTagsMutation();
  const sync = useBulkSyncMutation();
  const del = useBulkDeleteMutation();

  // SKU/barcode generation is variant-level, so the selection is flattened to
  // its variants. Counting the ones that actually LACK a code lets each button
  // state its scope up front and disable itself when there is nothing to do.
  //
  // Deliberately NOT gated on warehousing: the generate endpoints never were,
  // and the equivalent buttons on /products/inventory live inside the stock
  // table, so this bar is the only route to them for an org that has not
  // enabled it.
  const selectedVariants = selectedProducts.flatMap((p) => p.variants);
  const variantIds = selectedVariants.map((v) => v.id);
  const missingSkuCount = selectedVariants.filter((v) => !v.sku).length;
  const missingBarcodeCount = selectedVariants.filter((v) => !v.barcode).length;

  const generateSkus = useGenerateSkusMutation();
  const generateBarcodes = useGenerateBarcodesMutation();

  const [tagDialogOpen, setTagDialogOpen] = useState<"add" | "remove" | null>(null);
  const [tagsInput, setTagsInput] = useState("");
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);

  const isPending =
    archive.isPending ||
    setStatus.isPending ||
    addTags.isPending ||
    removeTags.isPending ||
    sync.isPending ||
    del.isPending ||
    generateSkus.isPending ||
    generateBarcodes.isPending;

  function handleAfter(action: () => void) {
    return () => {
      action();
      onClear();
    };
  }

  function handleArchive() {
    if (!confirm(`Archive ${editableCount} product${editableCount === 1 ? "" : "s"}?`)) return;
    archive.mutate(ids, { onSuccess: handleAfter(() => undefined) });
  }

  function handleDelete() {
    if (
      !confirm(
        `Permanently delete ${archivedCount} archived product${archivedCount === 1 ? "" : "s"}? Order history is preserved, but the products themselves are gone forever.`,
      )
    )
      return;
    del.mutate(ids, { onSuccess: handleAfter(() => undefined) });
  }

  function handleStatus(status: ProductStatus) {
    setStatusMenuOpen(false);
    setStatus.mutate({ productIds: ids, status }, { onSuccess: handleAfter(() => undefined) });
  }

  function commitTags() {
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length === 0) return;
    const fn = tagDialogOpen === "add" ? addTags : removeTags;
    fn.mutate({ productIds: ids, tags }, {
      onSuccess: () => {
        setTagDialogOpen(null);
        setTagsInput("");
        onClear();
      },
    });
  }

  function handleSync() {
    sync.mutate(ids, { onSuccess: handleAfter(() => undefined) });
  }

  return (
    <>
      <div className="sticky top-2 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-input bg-white dark:bg-gray-900 px-3 py-2 shadow-lg">
        <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
          {ids.length} selected
          {offPageCount > 0 && (
            <span className="ml-1 font-normal text-muted-foreground">
              ({offPageCount} on other pages)
            </span>
          )}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <ActionButton onClick={handleArchive} disabled={isPending || editableCount === 0}>
            <Archive className="size-3.5" /> Archive
          </ActionButton>

          <div className="relative">
            <ActionButton
              onClick={() => setStatusMenuOpen((v) => !v)}
              disabled={isPending || editableCount === 0}
            >
              <CheckCheck className="size-3.5" /> Status
            </ActionButton>
            {statusMenuOpen && (
              <div
                className="absolute right-0 top-9 z-40 w-32 rounded-lg border border-input bg-white dark:bg-gray-900 p-1 shadow-lg"
                onMouseLeave={() => setStatusMenuOpen(false)}
              >
                {(["ACTIVE", "DRAFT", "ARCHIVED"] as ProductStatus[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleStatus(s)}
                    className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    {s.charAt(0) + s.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          <ActionButton
            onClick={() => setTagDialogOpen("add")}
            disabled={isPending || editableCount === 0}
          >
            <Tag className="size-3.5" /> Add tags
          </ActionButton>
          <ActionButton
            onClick={() => setTagDialogOpen("remove")}
            disabled={isPending || editableCount === 0}
          >
            <Tag className="size-3.5" /> Remove tags
          </ActionButton>
          <ActionButton
            onClick={() =>
              generateSkus.mutate({ variantIds }, { onSuccess: handleAfter(() => undefined) })
            }
            disabled={isPending || missingSkuCount === 0}
            title={
              missingSkuCount === 0
                ? "Every selected variant already has a SKU"
                : `${missingSkuCount} of ${selectedVariants.length} variants need a SKU`
            }
          >
            <SlidersHorizontal className="size-3.5" /> Create SKUs ({missingSkuCount})
          </ActionButton>
          <ActionButton
            onClick={() =>
              generateBarcodes.mutate({ variantIds }, { onSuccess: handleAfter(() => undefined) })
            }
            disabled={isPending || missingBarcodeCount === 0}
            title={
              missingBarcodeCount === 0
                ? "Every selected variant already has a barcode"
                : `${missingBarcodeCount} of ${selectedVariants.length} variants need a barcode`
            }
          >
            <Barcode className="size-3.5" /> Create barcodes ({missingBarcodeCount})
          </ActionButton>
          <ActionButton onClick={handleSync} disabled={isPending || editableCount === 0}>
            <UploadCloud className="size-3.5" /> Sync to Shopify
          </ActionButton>
          {archivedCount > 0 && (
            <ActionButton
              onClick={handleDelete}
              disabled={isPending}
              tone="danger"
              title={`${archivedCount} of ${ids.length} are archived and can be permanently deleted`}
            >
              <Trash2 className="size-3.5" /> Delete forever
            </ActionButton>
          )}
          <button
            type="button"
            onClick={onClear}
            className="rounded p-1 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Clear selection"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {tagDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setTagDialogOpen(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white dark:bg-gray-900 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="border-b px-5 py-3">
              <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {tagDialogOpen === "add" ? "Add tags" : "Remove tags"}
              </h3>
              <p className="text-[11px] text-muted-foreground">
                Comma-separated. Applied to {editableCount} product{editableCount === 1 ? "" : "s"}.
              </p>
            </header>
            <div className="px-5 py-4">
              <input
                autoFocus
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="summer, sale"
                className="h-9 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
              />
            </div>
            <footer className="flex items-center gap-2 border-t px-5 py-3">
              <button
                type="button"
                onClick={commitTags}
                disabled={isPending || !tagsInput.trim()}
                className="flex-1 rounded-lg bg-[#CEF17B] px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F] disabled:opacity-50"
              >
                {isPending && <Loader2 className="mr-1.5 inline size-3 animate-spin" />}
                {tagDialogOpen === "add" ? "Add" : "Remove"}
              </button>
              <button
                type="button"
                onClick={() => setTagDialogOpen(null)}
                className="rounded-lg px-4 py-2 text-xs text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  tone = "default",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
  title?: string;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none ${
        tone === "danger"
          ? "bg-white dark:bg-gray-900 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
          : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
      }`}
    >
      {children}
    </button>
  );

  // A real tooltip rather than the native `title`, which never appears on
  // touch and is unreachable by keyboard — and these strings carry the only
  // statement of how many of the selected variants an action will change.
  // `disabled` is kept off the trigger wrapper so the tip still opens on a
  // button that has nothing to do, which is exactly when it explains why.
  if (!title) return button;
  return (
    <Tip text={title}>
      <span className="inline-flex">{button}</span>
    </Tip>
  );
}
