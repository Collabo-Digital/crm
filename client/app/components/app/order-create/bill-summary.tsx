import { formatCurrency } from "~/lib/utils";
import type { CartLine } from "./order-cart";
import type { OfflinePaymentMethod, Warehouse } from "~/types/api";

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
}) {
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  // Server-authoritative tax — UI estimate: assume 0 if gstRate unknown.
  const estimatedTax = lines.reduce((s, l) => {
    if (!l.gstRate) return s;
    return s + ((l.unitPrice * l.quantity * l.gstRate) / 100);
  }, 0);
  const grandTotal = subtotal + estimatedTax;

  return (
    <div className="space-y-4 rounded-xl border bg-white dark:bg-gray-900 p-4 shadow-sm">
      <div>
        <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
          Bill summary
        </p>
        <p className="text-[10px] text-muted-foreground">
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
            Tax (estimate)
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
            <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
              Dispatch from
            </span>
            <select
              value={warehouseId ?? ""}
              onChange={(e) => onWarehouseChange(e.target.value)}
              className="mt-1 h-8 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#CEF17B]/60"
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
          <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            Payment method
          </span>
          <select
            value={paymentMethod}
            onChange={(e) =>
              onPaymentMethodChange(e.target.value as OfflinePaymentMethod)
            }
            className="mt-1 h-8 w-full rounded-lg border border-input bg-white dark:bg-gray-800 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#CEF17B]/60"
          >
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="UPI">UPI</option>
            <option value="OTHER">Other</option>
          </select>
        </label>

        <label className="block">
          <span className="text-[10px] font-medium text-gray-600 dark:text-gray-400">
            Note (optional)
          </span>
          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-input bg-white dark:bg-gray-800 p-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#CEF17B]/60"
          />
        </label>
      </div>

      {!draftOnly && (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || isSubmitting || isSavingDraft}
          className="inline-flex w-full items-center justify-center rounded-lg bg-[#CEF17B] px-4 py-2.5 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F] disabled:pointer-events-none disabled:opacity-40"
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
              ? "inline-flex w-full items-center justify-center rounded-lg bg-[#CEF17B] px-4 py-2.5 text-xs font-semibold text-gray-900 hover:bg-[#BADE6F] disabled:pointer-events-none disabled:opacity-40"
              : "inline-flex w-full items-center justify-center rounded-lg border border-input bg-white dark:bg-gray-900 px-4 py-2 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:pointer-events-none disabled:opacity-40"
          }
        >
          {isSavingDraft ? "Saving draft…" : "Save as draft"}
        </button>
      )}

      {!canSubmit && disabledReason && (
        <p className="text-center text-[10px] text-amber-700 dark:text-amber-400">
          {disabledReason}
        </p>
      )}
    </div>
  );
}
