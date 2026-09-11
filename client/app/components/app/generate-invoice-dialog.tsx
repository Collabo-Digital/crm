import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useGstins, useIndianStates } from "~/hooks/use-gst-queries";
import { useWarehouses } from "~/hooks/use-inventory-queries";
import { useCreateInvoiceMutation } from "~/hooks/use-invoice-mutations";
import { formatCurrency } from "~/lib/utils";
import type { OrderDetail, OrganizationGstin } from "~/types/api";

/**
 * Mirrors `GSTIN_REGEX` in `server/src/gst/constants/gst-rates.ts`.
 *
 * Checked here only so a typo is caught inline instead of coming back as a
 * generic 400 toast — the server-side `@Matches` on `CreateInvoiceDto` is still
 * the authority.
 */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Generate a GST invoice for an order.
 *
 * Lifted out of `routes/app/orders/$id.tsx` and moved onto the `Dialog`
 * primitive. It was the last hand-rolled `fixed inset-0` overlay in the invoice
 * flow — backdrop-click to dismiss, but no focus trap and no Escape handling,
 * so keyboard users tabbed straight out of it into the page behind. Exactly the
 * bug already fixed in `invoice-detail-dialog.tsx`.
 */
export function GenerateInvoiceDialog({
  order,
  currency,
  open,
  onClose,
}: {
  order: OrderDetail;
  currency: string;
  open: boolean;
  onClose: () => void;
}) {
  // Both lists must distinguish "empty" from "failed to load". Previously a
  // failed request rendered exactly like a genuinely empty one — an empty
  // <Select> and the label "(No GSTINs registered)" — telling the user to go
  // register a GSTIN they may well already have.
  const {
    data: gstins = [],
    isLoading: gstinsLoading,
    isError: gstinsError,
    refetch: refetchGstins,
  } = useGstins();
  const {
    data: states = [],
    isError: statesError,
    refetch: refetchStates,
  } = useIndianStates();
  const createInvoice = useCreateInvoiceMutation();
  const lookupsFailed = gstinsError || statesError;

  const [sellerGstinId, setSellerGstinId] = useState("");
  const [buyerGstin, setBuyerGstin] = useState("");
  const [placeOfSupplyCode, setPlaceOfSupplyCode] = useState("");
  const [notes, setNotes] = useState("");
  const [reverseCharge, setReverseCharge] = useState(false);
  const [dispatchWarehouseId, setDispatchWarehouseId] = useState("");

  const activeGstins = gstins.filter((g: OrganizationGstin) => g.isActive);

  // A warehouse linked to a DIFFERENT registration than the chosen seller
  // GSTIN would be refused by the server, so it is not offered. Unlinked
  // warehouses stay eligible — they assert nothing to contradict.
  const warehouses = useWarehouses();
  const dispatchOptions = (warehouses.data ?? []).filter(
    (w) =>
      w.isActive && (!sellerGstinId || !w.gstinId || w.gstinId === sellerGstinId),
  );

  const buyerGstinInvalid = buyerGstin !== "" && !GSTIN_PATTERN.test(buyerGstin);

  // Disabled only when the list genuinely LOADED and came back empty.
  //
  // This used to read `activeGstins.length === 0`, which is also what a failed
  // lookup produces (the query defaults to []) — so the banner above told the
  // user "you can still generate the invoice, the server will auto-select"
  // while the button it referred to was disabled. The documented recovery path
  // was unreachable.
  const noGstinsRegistered =
    !gstinsError && !gstinsLoading && activeGstins.length === 0;

  function handleGenerate() {
    if (buyerGstinInvalid) return;
    createInvoice.mutate(
      {
        orderId: order.id,
        sellerGstinId: sellerGstinId || undefined,
        buyerGstin: buyerGstin || undefined,
        placeOfSupplyCode: placeOfSupplyCode || undefined,
        notes: notes.trim() || undefined,
        reverseCharge: reverseCharge || undefined,
        dispatchWarehouseId: dispatchWarehouseId || undefined,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't dismiss mid-request — the invoice would still be created with
        // no dialog left to report it.
        if (!next && !createInvoice.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate GST invoice</DialogTitle>
          <DialogDescription className="text-caption">
            Order {order.name}. Every field below is optional — the server
            resolves the seller GSTIN and place of supply when they are left
            blank.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Not a blocker: every field below is optional and the server
              auto-resolves the seller GSTIN and place of supply when they are
              omitted. So say what broke and offer a retry, but still let the
              invoice be generated. */}
          {lookupsFailed && (
            <div className="flex items-start justify-between gap-3 rounded-lg bg-danger-subtle px-3 py-2">
              <p className="text-micro text-danger">
                Couldn't load {gstinsError ? "your GSTINs" : ""}
                {gstinsError && statesError ? " and " : ""}
                {statesError ? "the state list" : ""}. You can still generate the
                invoice — the server will auto-select.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (gstinsError) refetchGstins();
                  if (statesError) refetchStates();
                }}
                className="shrink-0 text-micro font-medium text-danger underline"
              >
                Retry
              </button>
            </div>
          )}

          {noGstinsRegistered && (
            <div className="rounded-lg bg-warning-strong-subtle px-3 py-2">
              <p className="text-micro text-warning-strong">
                No active GSTIN is registered. Add one in Settings → Tax &amp;
                GST before issuing an invoice.
              </p>
            </div>
          )}

          <div>
            <label
              htmlFor="seller-gstin"
              className="text-micro font-medium text-muted-foreground"
            >
              Seller GSTIN{" "}
              {gstinsError
                ? "(Couldn't load)"
                : gstinsLoading
                  ? "(Loading…)"
                  : activeGstins.length === 0
                    ? "(None registered)"
                    : ""}
            </label>
            <Select value={sellerGstinId} onValueChange={setSellerGstinId}>
              <SelectTrigger id="seller-gstin" className="mt-1 h-9 text-caption">
                <SelectValue placeholder="Auto-select based on place of supply" />
              </SelectTrigger>
              <SelectContent>
                {activeGstins.map((g: OrganizationGstin) => (
                  <SelectItem key={g.id} value={g.id} className="text-caption">
                    {g.gstin} — {g.stateName} {g.isDefault ? "(Default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Only worth asking when there is a choice to make. The list is
              filtered to warehouses compatible with the chosen seller GSTIN,
              because the server refuses an explicit cross-registration pick
              outright — better to not offer it than to explain the 400. */}
          {dispatchOptions.length > 1 && (
            <div>
              <label
                htmlFor="dispatch-warehouse"
                className="text-micro font-medium text-muted-foreground"
              >
                Dispatch from (optional)
              </label>
              <Select
                value={dispatchWarehouseId}
                onValueChange={setDispatchWarehouseId}
              >
                <SelectTrigger id="dispatch-warehouse" className="mt-1 h-9 text-caption">
                  <SelectValue placeholder="Auto — the order's warehouse, else the default" />
                </SelectTrigger>
                <SelectContent>
                  {dispatchOptions.map((w) => (
                    <SelectItem key={w.id} value={w.id} className="text-caption">
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <label
              htmlFor="buyer-gstin"
              className="text-micro font-medium text-muted-foreground"
            >
              Buyer GSTIN (optional — leave empty for B2C)
            </label>
            <input
              id="buyer-gstin"
              value={buyerGstin}
              onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())}
              placeholder="e.g. 29AABCT1332L1ZN"
              maxLength={15}
              aria-invalid={buyerGstinInvalid}
              aria-describedby={buyerGstinInvalid ? "buyer-gstin-error" : undefined}
              className={`mt-1 w-full rounded-lg border bg-background px-3 py-2 font-mono text-caption outline-none focus:ring-1 ${
                buyerGstinInvalid
                  ? "border-danger focus:ring-danger"
                  : "focus:ring-brand"
              }`}
            />
            {buyerGstinInvalid && (
              <p id="buyer-gstin-error" className="mt-1 text-micro text-danger">
                That isn't a valid 15-character GSTIN.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="place-of-supply"
              className="text-micro font-medium text-muted-foreground"
            >
              Place of Supply
            </label>
            <Select value={placeOfSupplyCode} onValueChange={setPlaceOfSupplyCode}>
              <SelectTrigger id="place-of-supply" className="mt-1 h-9 text-caption">
                <SelectValue placeholder="Auto-detect from shipping address" />
              </SelectTrigger>
              <SelectContent>
                {states.map((s) => (
                  <SelectItem key={s.code} value={s.code} className="text-caption">
                    {s.code} - {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Rule 46(p) requires every tax invoice to declare whether tax is
              payable on reverse charge. The column existed and nothing wrote
              it, so the printed declaration could only ever read "No". */}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={reverseCharge}
              onChange={(e) => setReverseCharge(e.target.checked)}
              className="mt-0.5 size-3.5 rounded border-input"
            />
            <span className="text-micro text-muted-foreground">
              <span className="font-medium text-foreground">
                Tax payable on reverse charge
              </span>
              <br />
              Tick only when the RECIPIENT is liable for the tax. Printed on the
              invoice either way.
            </span>
          </label>

          {/* The API has always accepted `notes` and both the detail dialog and
              the printed invoice render them — no UI ever sent them. */}
          <div>
            <label
              htmlFor="invoice-notes"
              className="text-micro font-medium text-muted-foreground"
            >
              Notes (optional — printed on the invoice)
            </label>
            <Textarea
              id="invoice-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. payment terms, PO reference"
              className="mt-1 text-caption"
            />
          </div>

          <div className="rounded-lg border bg-surface-sunken p-3 dark:bg-muted/40">
            <p className="mb-1 text-micro uppercase tracking-wider text-muted-foreground">
              Order Summary
            </p>
            <div className="space-y-0.5 text-caption">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Items</span>
                <span>{order.lineItems.length}</span>
              </div>
              <div className="flex justify-between font-semibold text-foreground">
                <span>Total</span>
                <span className="tabular-nums">
                  {formatCurrency(Number(order.totalPrice), currency)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={createInvoice.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="brand"
            size="sm"
            onClick={handleGenerate}
            disabled={
              createInvoice.isPending || noGstinsRegistered || buyerGstinInvalid
            }
          >
            {createInvoice.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Check />
            )}
            Generate invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
