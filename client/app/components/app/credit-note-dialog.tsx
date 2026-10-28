import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { useCreateCreditNoteMutation } from "~/hooks/use-invoice-mutations";
import { formatCurrency } from "~/lib/utils";
/**
 * Narrower than InvoiceDetail on purpose: the dialog is opened both from the
 * invoice detail view and from the refunds banner, and the banner has only a
 * summary. Requiring the full detail there would mean an extra fetch to render
 * a form that needs three fields.
 */
export interface CreditNoteTarget {
  id: string;
  invoiceNumber: string;
  grandTotal: string | number;
}

/** Figures carried over from a refund, so nothing is re-keyed off Shopify. */
export interface CreditNotePrefill {
  amount: string | number;
  /** NULL when the channel never reported the tax — shown as unknown, not zero. */
  tax: string | null;
  reason: string | null;
}

/**
 * Raise a credit note against an issued invoice.
 *
 * The statutory correction for a sale that was refunded or wrongly billed, and
 * the one this module never had: refunds carried no tax at all, so a refunded
 * sale stayed 100% in declared output liability for ever.
 *
 * Cancelling is NOT the same thing. Cancelling makes an invoice vanish from a
 * regenerated return, which silently contradicts what was already filed; a
 * credit note is additive and leaves both documents in the record.
 */
export function CreditNoteDialog({
  invoice,
  currency,
  prefill,
  onClose,
}: {
  invoice: CreditNoteTarget | null;
  currency: string;
  prefill?: CreditNotePrefill | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [partial, setPartial] = useState(false);
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");
  const mutation = useCreateCreditNoteMutation();

  useEffect(() => {
    if (!invoice) return;
    // Pre-filled from the refund when the dialog was opened from the banner,
    // blank when opened from the invoice itself.
    setReason(prefill?.reason ?? "");
    setPartial(!!prefill);
    setAmount(prefill ? String(prefill.amount) : "");
    setTax(prefill?.tax != null ? String(prefill.tax) : "");
  }, [invoice, prefill]);

  if (!invoice) return null;

  const invoiceTotal = Number(invoice.grandTotal);
  const parsedAmount = Number(amount);
  const amountInvalid =
    partial &&
    (!Number.isFinite(parsedAmount) ||
      parsedAmount <= 0 ||
      parsedAmount > invoiceTotal);
  const taxGiven = partial && tax.trim() !== "";
  const parsedTax = Number(tax);
  const taxInvalid =
    taxGiven &&
    (!Number.isFinite(parsedTax) ||
      parsedTax < 0 ||
      (!amountInvalid && parsedTax > parsedAmount));

  function submit() {
    if (!reason.trim() || amountInvalid || taxInvalid) return;
    mutation.mutate(
      {
        id: invoice!.id,
        data: {
          reason: reason.trim(),
          // Omitted means a FULL reversal of whatever remains uncredited.
          amount: partial ? parsedAmount : undefined,
          // Blank lets the server work it out from the invoice: goods first.
          tax: taxGiven ? parsedTax : undefined,
        },
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open={!!invoice} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Raise a credit note</DialogTitle>
          <DialogDescription>
            Reverses {invoice.invoiceNumber} (
            {formatCurrency(invoiceTotal, currency)}). The invoice stays in the
            return and the note nets against it — nothing is deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="cn-reason"
              className="text-micro font-medium text-muted-foreground"
            >
              Reason (printed on the note and reported with it)
            </label>
            <input
              id="cn-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Goods returned"
              className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-caption focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            />
          </div>

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={partial}
              onChange={(e) => setPartial(e.target.checked)}
              className="mt-0.5 size-3.5 rounded border-input"
            />
            <span className="text-micro text-muted-foreground">
              <span className="font-medium text-foreground">
                Credit part of this invoice
              </span>
              <br />
              Spread across the original lines, so each keeps its own GST
              rate. Leave unticked to reverse the invoice in full.
            </span>
          </label>

          {prefill && prefill.tax === null && (
            // The refund arrived without a tax breakdown. Raising a note for
            // the refunded amount would reverse the sale value while leaving
            // all of its output tax declared, so say so rather than let the
            // apportionment quietly guess.
            <p className="rounded-lg bg-warning-subtle px-3 py-2 text-micro">
              The sales channel did not report how much tax was refunded. Enter
              the GST from your channel, or leave it blank to work it out from
              the invoice (items first, then shipping).
            </p>
          )}

          {partial && (
            <div>
              <label
                htmlFor="cn-amount"
                className="text-micro font-medium text-muted-foreground"
              >
                Amount to credit (including tax)
              </label>
              <input
                id="cn-amount"
                type="number"
                min="0.01"
                step="0.01"
                max={invoiceTotal}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={amountInvalid}
                aria-describedby={amountInvalid ? "cn-amount-error" : undefined}
                className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-caption focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
              />
              {amountInvalid && (
                <p id="cn-amount-error" className="mt-1 text-micro text-destructive">
                  Enter an amount between 0 and{" "}
                  {formatCurrency(invoiceTotal, currency)}.
                </p>
              )}
            </div>
          )}

          {partial && (
            <div>
              <label
                htmlFor="cn-tax"
                className="text-micro font-medium text-muted-foreground"
              >
                GST included in this amount (optional)
              </label>
              <input
                id="cn-tax"
                type="number"
                min="0"
                step="0.01"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
                aria-invalid={taxInvalid}
                aria-describedby="cn-tax-help"
                placeholder="Work it out from the invoice"
                className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-caption focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
              />
              {taxInvalid ? (
                <p id="cn-tax-help" className="mt-1 text-micro text-destructive">
                  The GST cannot be negative or more than the amount.
                </p>
              ) : (
                <p id="cn-tax-help" className="mt-1 text-micro text-muted-foreground">
                  Blank credits the items first, at the invoice's GST rates,
                  then any untaxed shipping.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!reason.trim() || amountInvalid || taxInvalid || mutation.isPending}
          >
            {mutation.isPending && (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            )}
            Raise credit note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
