import { Trash2, AlertTriangle, Info } from "lucide-react";
import { formatCurrency } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export type CartLine = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  quantity: number;
  unitPrice: number;
  inventoryQuantity: number;
  /** Server is source of truth at submit; preview shows 0 if unknown. */
  gstRate: number | null;
  /**
   * When true, this line is allowed to oversell — either the org or the
   * variant opted into continue-selling-when-out-of-stock. Drives the cart's
   * overflow indicator (amber backorder note vs. red error).
   */
  canOversell: boolean;
};

export function OrderCart({
  lines,
  onUpdate,
  onRemove,
  currency,
}: {
  lines: CartLine[];
  onUpdate: (variantId: string, patch: Partial<CartLine>) => void;
  onRemove: (variantId: string) => void;
  currency: string;
}) {
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-white dark:bg-gray-900 p-6 text-center">
        <p className="text-xs text-muted-foreground">
          No products added yet. Use the search above to add items to this
          order.
        </p>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-3 sm:hidden">
      {lines.map((line) => (
        <article key={line.variantId} className="rounded-xl border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="break-words text-body font-semibold">{line.productTitle}</p>
              <p className="mt-1 text-caption text-muted-foreground">{line.variantTitle}</p>
            </div>
            <Button type="button" variant="ghost" size="icon" className="shrink-0 text-muted-foreground" onClick={() => onRemove(line.variantId)} aria-label={`Remove ${line.productTitle}`}>
              <Trash2 className="size-4" />
            </Button>
          </div>
          {line.quantity > line.inventoryQuantity && (
            <p className={`mt-3 flex items-start gap-1.5 text-caption ${line.canOversell ? "text-warning-strong" : "text-danger"}`}>
              {line.canOversell ? <Info className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
              {line.canOversell ? `Backorder · ${Math.max(0, line.inventoryQuantity)} in stock, ordering ${line.quantity}` : `Only ${line.inventoryQuantity} in stock`}
            </p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-caption text-muted-foreground">
              <span>Quantity</span>
              <Input type="number" inputMode="numeric" min={1} value={line.quantity} className="tabular-nums text-foreground" onChange={(e) => onUpdate(line.variantId, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
            </label>
            <label className="space-y-1.5 text-caption text-muted-foreground">
              <span>Unit price</span>
              <Input type="number" inputMode="decimal" min={0} step="0.01" value={line.unitPrice} className="tabular-nums text-foreground" onChange={(e) => onUpdate(line.variantId, { unitPrice: Math.max(0, parseFloat(e.target.value) || 0) })} />
            </label>
          </div>
          <div className="mt-4 flex items-center justify-between border-t pt-3 text-caption">
            <span className="text-muted-foreground">Line total</span>
            <span className="text-body font-semibold tabular-nums">{formatCurrency(line.unitPrice * line.quantity, currency)}</span>
          </div>
        </article>
      ))}
    </div>
    <div className="hidden overflow-x-auto rounded-lg border bg-white dark:bg-gray-900 sm:block">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 dark:bg-gray-800/50 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Item</th>
            <th className="px-3 py-2 text-right font-medium">Qty</th>
            <th className="px-3 py-2 text-right font-medium">Unit price</th>
            <th className="px-3 py-2 text-right font-medium">Line total</th>
            <th className="px-3 py-2 w-10" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((l) => {
            const lineTotal = l.unitPrice * l.quantity;
            const overflow = l.quantity > l.inventoryQuantity;
            return (
              <tr key={l.variantId}>
                <td className="px-3 py-2">
                  <p className="font-medium text-gray-900 dark:text-gray-100 truncate max-w-[18rem]">
                    {l.productTitle}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate max-w-[18rem]">
                    {l.variantTitle}
                  </p>
                  {overflow &&
                    (l.canOversell ? (
                      <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
                        <Info className="size-3" />
                        Backorder — {Math.max(0, l.inventoryQuantity)} in stock, ordering {l.quantity}
                      </p>
                    ) : (
                      <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-red-600">
                        <AlertTriangle className="size-3" />
                        Only {l.inventoryQuantity} in stock
                      </p>
                    ))}
                </td>
                <td className="px-3 py-2 text-right">
                  <input
                    type="number"
                    aria-label={`Quantity for ${l.productTitle}`}
                    min={1}
                    value={l.quantity}
                    onChange={(e) =>
                      onUpdate(l.variantId, {
                        quantity: Math.max(1, parseInt(e.target.value, 10) || 1),
                      })
                    }
                    className="h-7 w-16 rounded-md border border-input bg-white dark:bg-gray-800 px-2 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-[#CEF17B]/60"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <input
                    type="number"
                    aria-label={`Unit price for ${l.productTitle}`}
                    min={0}
                    step="0.01"
                    value={l.unitPrice}
                    onChange={(e) =>
                      onUpdate(l.variantId, {
                        unitPrice: Math.max(0, parseFloat(e.target.value) || 0),
                      })
                    }
                    className="h-7 w-24 rounded-md border border-input bg-white dark:bg-gray-800 px-2 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-[#CEF17B]/60"
                  />
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">
                  {formatCurrency(lineTotal, currency)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    aria-label={`Remove ${l.productTitle}`}
                    onClick={() => onRemove(l.variantId)}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-red-600"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}
