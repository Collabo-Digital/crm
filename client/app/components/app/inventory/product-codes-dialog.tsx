import { useState } from "react";
import { Link } from "react-router";
import { Barcode, Check, Loader2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  useGenerateBarcodesMutation,
  useGenerateSkusMutation,
} from "~/hooks/use-inventory-mutations";
import { useCodeStatus } from "~/hooks/use-inventory-queries";
import { CODE_TERMS } from "~/lib/inventory-vocabulary";

/**
 * The one place a merchant fixes missing or unprintable product codes.
 *
 * Replaces three lookalike toolbar buttons — "Generate all missing SKUs",
 * "Generate all missing barcodes" and "Switch all to short codes" — which sat
 * side by side in the Inventory header with no definition of either word
 * anywhere on the page, identical styling on the safe fills and the
 * destructive replace, and a raw window.confirm guarding the last one.
 *
 * Three rules hold this together:
 *
 *  1. Each row states an OUTCOME with a real number ("40 barcodes are too long
 *     to print on small labels"), never a verb plus jargon ("switch to short
 *     codes"). The merchant should not have to know what "short" means.
 *  2. A row is rendered only when its count is above zero. Counts come from
 *     the server, so they describe the set the action actually changes — the
 *     old buttons counted the current page's selection while acting org-wide.
 *     A clean catalogue sees no rows at all, which is the normal state now
 *     that both codes are minted at creation.
 *  3. The destructive row confirms in place, naming the consequence, rather
 *     than in a browser popup that cannot be styled or read on a phone.
 */
export function ProductCodesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = useCodeStatus(open);
  const generateSkus = useGenerateSkusMutation();
  const generateBarcodes = useGenerateBarcodesMutation();
  const [confirmingShorten, setConfirmingShorten] = useState(false);

  const busy = generateSkus.isPending || generateBarcodes.isPending;
  const s = status.data;

  // Resolved server-side, through the same fallback the generator uses. The
  // settings screen can show "———" beside its input because an empty box is
  // right there explaining it; here there is no input, so a placeholder would
  // just read as a broken preview.
  const skuPreview = s ? `${s.skuPrefix}-SAR-001` : "";

  const nothingToDo =
    !!s && s.missingSku === 0 && s.missingBarcode === 0 && s.longBarcode === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConfirmingShorten(false);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Product codes</DialogTitle>
          <DialogDescription>
            This checks your whole catalogue, not one location.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg bg-info-subtle px-4 py-3 text-caption">
          <p className="mb-1.5">
            <strong className="font-semibold">{CODE_TERMS.sku.label}</strong> —{" "}
            {CODE_TERMS.sku.definition}
          </p>
          <p>
            <strong className="font-semibold">{CODE_TERMS.barcode.label}</strong>{" "}
            — {CODE_TERMS.barcode.definition}
          </p>
        </div>

        {status.isLoading && (
          <p className="flex items-center gap-2 py-4 text-caption text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Checking your catalogue…
          </p>
        )}

        {status.isError && (
          <div className="rounded-lg bg-danger-subtle px-4 py-3 text-caption">
            <p className="mb-2">Could not check your product codes.</p>
            <Button size="sm" variant="outline" onClick={() => status.refetch()}>
              Try again
            </Button>
          </div>
        )}

        {s && (
          <div className="space-y-2.5">
            {s.missingSku > 0 && (
              <TaskRow
                headline={`${s.missingSku} ${plural(s.missingSku, "product")} ${
                  s.missingSku === 1 ? "has" : "have"
                } no SKU`}
                detail={`New ones will look like ${skuPreview}.`}
                action="Create SKUs"
                busy={busy}
                pending={generateSkus.isPending}
                onAction={() => generateSkus.mutate({ filter: "missing-sku" })}
              />
            )}

            {s.missingBarcode > 0 && (
              <TaskRow
                headline={`${s.missingBarcode} ${plural(
                  s.missingBarcode,
                  "product",
                )} ${s.missingBarcode === 1 ? "has" : "have"} no barcode`}
                detail="6-digit numbers, so they fit small labels."
                action="Create barcodes"
                busy={busy}
                pending={generateBarcodes.isPending && !confirmingShorten}
                onAction={() =>
                  generateBarcodes.mutate({
                    filter: "missing-barcode",
                    format: "short",
                  })
                }
              />
            )}

            {s.longBarcode > 0 &&
              (confirmingShorten ? (
                <div className="rounded-lg bg-warning-subtle px-4 py-3">
                  <p className="text-label font-medium">
                    Labels already printed with the old codes will need
                    reprinting
                  </p>
                  <p className="mt-1 text-caption">
                    Barcodes that came from Shopify, and ones you typed
                    yourself, are not touched.
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        // NOT `overwrite: true` — that bypasses filtering in
                        // loadTargets and would clobber real GTINs synced from
                        // Shopify. `missing-or-generated` is the safe set.
                        generateBarcodes.mutate(
                          { filter: "missing-or-generated", format: "short" },
                          { onSettled: () => setConfirmingShorten(false) },
                        )
                      }
                    >
                      {generateBarcodes.isPending && (
                        <Loader2 className="size-3.5 animate-spin" />
                      )}
                      Shorten {s.longBarcode} barcodes
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmingShorten(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <TaskRow
                  headline={`${s.longBarcode} ${plural(
                    s.longBarcode,
                    "barcode",
                  )} ${
                    s.longBarcode === 1 ? "is" : "are"
                  } too long to print on small labels`}
                  detail="Replaced with short 6-digit numbers."
                  action="Shorten them"
                  busy={busy}
                  pending={false}
                  onAction={() => setConfirmingShorten(true)}
                />
              ))}

            {nothingToDo && (
              <div className="rounded-lg bg-success-subtle px-4 py-3">
                <p className="flex items-center gap-2 text-label font-medium">
                  <Check className="size-4" />
                  Every product has a SKU and a barcode
                </p>
                <p className="mt-1 text-caption">
                  New products get both automatically, so this stays clear.
                </p>
                <Button asChild size="sm" variant="outline" className="mt-2.5">
                  <Link
                    to="/products/inventory"
                    onClick={() => onOpenChange(false)}
                  >
                    <Barcode className="size-3.5" />
                    Back to Inventory
                  </Link>
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskRow({
  headline,
  detail,
  action,
  onAction,
  busy,
  pending,
}: {
  headline: string;
  detail: string;
  action: string;
  onAction: () => void;
  busy: boolean;
  pending: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted px-4 py-3">
      <p className="text-label font-medium">{headline}</p>
      <p className="mt-1 text-caption text-muted-foreground">{detail}</p>
      <Button
        size="sm"
        variant="outline"
        className="mt-2.5"
        disabled={busy}
        onClick={onAction}
      >
        {pending && <Loader2 className="size-3.5 animate-spin" />}
        {action}
      </Button>
    </div>
  );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
