import { useId, useState } from "react";
import {
  Archive,
  Barcode,
  CheckCheck,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  SlidersHorizontal,
  Tag,
  Trash2,
  UploadCloud,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { DockButton, FloatingDock } from "~/components/app/floating-dock";
import { ModalFrame, ModalTitle } from "~/components/app/order-dialog-primitives";

/**
 * Floating dock of bulk actions shown while one or more products are selected.
 * Status, tagging, sync, archive and delete sit in the pill; the less frequent
 * remove-tags and SKU/barcode generation live in its overflow menu.
 *
 * Both MANUAL and SHOPIFY-channel products are now editable — the prior
 * "read-only" carve-out for synced products was removed. Bulk actions touch
 * every selected product; the only "skipped" reason left is "Not found".
 */
export function BulkActionBar({
  canDelete,
  selectedProducts,
  offPageCount = 0,
  onClear,
}: {
  /** Permanent delete is owner/admin/manager only on the server. */
  canDelete: boolean;
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
  const tagHelpId = useId();
  const [tagsInput, setTagsInput] = useState("");

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
      <FloatingDock
        count={ids.length}
        noun="selected"
        summary={offPageCount > 0 ? `${offPageCount} on other pages` : undefined}
        onClear={onClear}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <DockButton disabled={isPending || editableCount === 0}>
              <CheckCheck /> Status <ChevronDown className="-ml-0.5 opacity-60" />
            </DockButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={10} className="w-36">
            {(["ACTIVE", "DRAFT", "ARCHIVED"] as ProductStatus[]).map((s) => (
              <DropdownMenuItem key={s} onSelect={() => handleStatus(s)}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DockButton
          onClick={() => setTagDialogOpen("add")}
          disabled={isPending || editableCount === 0}
        >
          <Tag /> Add tags
        </DockButton>
        <DockButton onClick={handleSync} disabled={isPending || editableCount === 0}>
          <UploadCloud /> Sync to Shopify
        </DockButton>
        <DockButton onClick={handleArchive} disabled={isPending || editableCount === 0}>
          <Archive /> Archive
        </DockButton>
        {canDelete && archivedCount > 0 && (
          <Tip
            text={`Delete forever — ${archivedCount} of ${ids.length} are archived and can be permanently deleted`}
          >
            <span className="inline-flex">
              <DockButton
                tone="danger"
                iconOnly
                onClick={handleDelete}
                disabled={isPending}
                aria-label="Delete forever"
              >
                <Trash2 />
              </DockButton>
            </span>
          </Tip>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <DockButton iconOnly disabled={isPending} aria-label="More actions">
              <MoreHorizontal />
            </DockButton>
          </DropdownMenuTrigger>
          {/* "Remove tags" opens the tag modal; without this the menu hands
              focus back to its trigger on close and steals it from the
              modal's input. */}
          <DropdownMenuContent
            side="top"
            align="end"
            sideOffset={10}
            className="w-60"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <DropdownMenuItem
              onSelect={() => setTagDialogOpen("remove")}
              disabled={editableCount === 0}
            >
              <Tag /> Remove tags
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* The scope line is the only statement of how many of the
                selected variants a generate action will change. */}
            <DropdownMenuItem
              onSelect={() =>
                generateSkus.mutate({ variantIds }, { onSuccess: handleAfter(() => undefined) })
              }
              disabled={missingSkuCount === 0}
              className="items-start"
            >
              <SlidersHorizontal className="mt-0.5" />
              <span className="flex flex-col">
                Create SKUs ({missingSkuCount})
                <span className="text-caption text-muted-foreground">
                  {missingSkuCount === 0
                    ? "Every selected variant already has a SKU"
                    : `${missingSkuCount} of ${selectedVariants.length} variants need a SKU`}
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                generateBarcodes.mutate({ variantIds }, { onSuccess: handleAfter(() => undefined) })
              }
              disabled={missingBarcodeCount === 0}
              className="items-start"
            >
              <Barcode className="mt-0.5" />
              <span className="flex flex-col">
                Create barcodes ({missingBarcodeCount})
                <span className="text-caption text-muted-foreground">
                  {missingBarcodeCount === 0
                    ? "Every selected variant already has a barcode"
                    : `${missingBarcodeCount} of ${selectedVariants.length} variants need a barcode`}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </FloatingDock>

      {tagDialogOpen && (
        <ModalFrame
          onClose={() => setTagDialogOpen(null)}
          describedBy={tagHelpId}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          className="w-full max-w-md rounded-xl bg-white dark:bg-gray-900 shadow-xl outline-none"
        >
            <header className="border-b px-5 py-3">
              <ModalTitle className="text-sm font-bold text-gray-900 dark:text-gray-100">
                {tagDialogOpen === "add" ? "Add tags" : "Remove tags"}
              </ModalTitle>
              <p id={tagHelpId} className="text-[11px] text-muted-foreground">
                Comma-separated. Applied to {editableCount} product{editableCount === 1 ? "" : "s"}.
              </p>
            </header>
            <div className="px-5 py-4">
              <input
                autoFocus
                aria-label="Tags"
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
        </ModalFrame>
      )}
    </>
  );
}
