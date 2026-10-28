import { formatCurrency } from "~/lib/utils";
import type { CartLine } from "./order-cart";
import type { OfflinePaymentMethod, Warehouse } from "~/types/api";

/**
 * The bill's figures as the form shows them. The server computes the final
 * tax; this is the estimate, shared by the summary and the phone's total bar.
 */
export function billTotals(lines: CartLine[], pricesIncludeTax: boolean) {
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  // Server-authoritative tax — UI estimate: assume 0 if gstRate unknown.
  const estimatedTax = lines.reduce((s, l) => {
    if (!l.gstRate) return s;
    if (pricesIncludeTax) {
      // Rounded per line as the server does, so the figures match to the paisa.
      const amount = round2(l.unitPrice * l.quantity);
      return s + round2(amount - round2((amount * 100) / (100 + l.gstRate)));
    }
    return s + ((l.unitPrice * l.quantity * l.gstRate) / 100);
  }, 0);
  const grandTotal = pricesIncludeTax ? subtotal : subtotal + estimatedTax;
  return { subtotal, estimatedTax, grandTotal };
}

export function BillSummary({
  lines,
  currency,
  paymentMethod,
  onPaymentMethodChange,
  warehouses,
  warehouseId,
  onWarehouseChange,
  note,
  onNoteChange,
  isSubmitting,
  canSubmit,
  disabledReason,
  onSubmit,
  onSaveDraft,
  isSavingDraft,
  /**
   * When true, the primary "Create order" button is hidden and the draft
   * button becomes the primary action. Used by the standalone /drafts/new
   * route where the only path forward is to save a draft.
   */
  draftOnly = false,
  pricesIncludeTax = false,
}: {
  lines: CartLine[];
  currency: string;
  paymentMethod: OfflinePaymentMethod;
  onPaymentMethodChange: (m: OfflinePaymentMethod) => void;
  /** Active warehouses; the picker only appears when there is a choice. */
  warehouses?: Warehouse[];
  warehouseId?: string;
  onWarehouseChange?: (id: string) => void;
  note: string;
  onNoteChange: (n: string) => void;
  isSubmitting: boolean;
  canSubmit: boolean;
  disabledReason: string | null;
  onSubmit: () => void;
  onSaveDraft?: () => void;
  isSavingDraft?: boolean;
  draftOnly?: boolean;
  /**
   * The org's prices already include GST, so the server takes the tax out of
   * each line instead of adding it: the total is the sum of the prices.
   */
  pricesIncludeTax?: boolean;
}) {
  const { subtotal, estimatedTax, grandTotal } = billTotals(lines, pricesIncludeTax);

  return (
    <div className="space-y-4 rounded-xl border bg-white dark:bg-gray-900 p-4 shadow-sm">
      <div>
        <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
          Bill summary
        </p>
        <p className="text-caption text-muted-foreground">
          Final tax is computed by the server using GST rules at submit.
        </p>
      </div>

      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="tabular-nums">
            {formatCurrency(subtotal, currency)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            {pricesIncludeTax ? "GST included (estimate)" : "Tax (estimate)"}
          </span>
          <span className="tabular-nums">
            {formatCurrency(estimatedTax, currency)}
          </span>
        </div>
        <div className="flex justify-between border-t pt-1 font-semibold text-gray-900 dark:text-gray-100">
          <span>Estimated total</span>
          <span className="tabular-nums">
            {formatCurrency(grandTotal, currency)}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {/* Only asked when the merchant actually has branches to choose
            between. With one warehouse the answer is never in doubt, and the
            invoice resolves the default on its own. */}
        {warehouses && warehouses.length > 1 && onWarehouseChange && (
          <label className="block">
            <span className="text-caption font-medium text-gray-600 dark:text-gray-400">
              Dispatch from
            </span>
            <select
              value={warehouseId ?? ""}
              onChange={(e) => onWarehouseChange(e.target.value)}
              className="mt-1 h-8 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-2 text-xs focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className="text-caption font-medium text-gray-600 dark:text-gray-400">
            Payment method
          </span>
          <select
            value={paymentMethod}
            onChange={(e) =>
              onPaymentMethodChange(e.target.value as OfflinePaymentMethod)
            }
            className="mt-1 h-8 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-2 text-xs focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          >
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="UPI">UPI</option>
            <option value="OTHER">Other</option>
          </select>
        </label>

        <label className="block">
          <span className="text-caption font-medium text-gray-600 dark:text-gray-400">
            Note (optional)
          </span>
          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-input bg-white dark:bg-gray-800 p-2 text-xs focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
        </label>
      </div>

      {!draftOnly && (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || isSubmitting || isSavingDraft}
          className="inline-flex w-full items-center justify-center rounded-lg bg-[#CEF17B] px-4 py-2.5 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F] disabled:pointer-events-none disabled:opacity-40 max-md:min-h-11 max-md:text-label pointer-coarse:min-h-11"
        >
          {isSubmitting ? "Creating order…" : "Create order & generate bill"}
        </button>
      )}

      {/* Optional secondary action: persist as a draft instead of finalizing.
          Style differs based on whether this is the primary action or not. */}
      {onSaveDraft && (
        <button
          type="button"
          onClick={onSaveDraft}
          disabled={!canSubmit || isSubmitting || isSavingDraft}
          className={
            draftOnly
              ? "inline-flex w-full items-center justify-center rounded-lg bg-[#CEF17B] px-4 py-2.5 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F] disabled:pointer-events-none disabled:opacity-40 max-md:min-h-11 max-md:text-label pointer-coarse:min-h-11"
              : "inline-flex w-full items-center justify-center rounded-lg border border-input bg-white dark:bg-gray-900 px-4 py-2 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:pointer-events-none disabled:opacity-40 max-md:min-h-11 max-md:text-label pointer-coarse:min-h-11"
          }
        >
          {isSavingDraft ? "Saving draft…" : "Save as draft"}
        </button>
      )}

      {!canSubmit && disabledReason && (
        <p className="text-center text-caption text-amber-700 dark:text-amber-400">
          {disabledReason}
        </p>
      )}
    </div>
  );
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
