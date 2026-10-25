import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, Banknote, CreditCard, Loader2, QrCode, Wallet, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { UpiQr } from "~/components/app/pos/upi-qr";
import { useMediaQuery } from "~/hooks/use-media-query";
import { quickCashAmounts, round2, upiPayUri } from "~/lib/pos-cart";
import { cn, formatCurrency } from "~/lib/utils";
import type { PosPaymentInput, PosPaymentMethod } from "~/types/api";

const inr = (n: number) => formatCurrency(n, "INR");
const whole = (n: number) => formatCurrency(n, "INR", { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });

const METHODS: Array<{ id: PosPaymentMethod; label: string; icon: typeof Banknote }> = [
  { id: "CASH", label: "Cash", icon: Banknote },
  { id: "UPI", label: "UPI", icon: QrCode },
  { id: "CARD", label: "Card", icon: CreditCard },
  { id: "OTHER", label: "Other", icon: Wallet },
];

export const METHOD_LABEL: Record<PosPaymentMethod, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", OTHER: "Other" };

/** Change owed on a cash payment, from what was handed over. */
const changeOf = (p: PosPaymentInput) => (p.method === "CASH" && p.tendered ? round2(p.tendered - p.amount) : 0);

/**
 * Takes payment for a sale: cash with change, UPI by QR, card or anything
 * else, split across several until the bill is covered — then the sale is
 * sent at once. A bill can also be finished with a balance due. In "collect"
 * mode it takes one payment towards a sale's balance.
 */
export function PaymentDialog({
  open,
  onOpenChange,
  mode,
  due,
  billRef,
  upi,
  canManage,
  hasCustomer,
  submitting,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "sale" | "collect";
  /** The payable for a sale, or the balance still due. */
  due: number;
  billRef: string;
  upi: { upiId: string; payeeName: string } | null;
  canManage: boolean;
  hasCustomer: boolean;
  submitting: boolean;
  /** The server's sentence from the last attempt. */
  error: string | null;
  onSubmit: (payments: PosPaymentInput[]) => void;
}) {
  const [payments, setPayments] = useState<PosPaymentInput[]>([]);
  const [method, setMethod] = useState<PosPaymentMethod>("CASH");
  const [amountText, setAmountText] = useState("");
  const [reference, setReference] = useState("");
  const [confirmingBalance, setConfirmingBalance] = useState(false);
  // On a touch screen the keyboard would cover the quick cash buttons.
  const finePointer = useMediaQuery("(pointer: fine)");

  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
  const remaining = round2(Math.max(0, due - paid));
  const change = round2(payments.reduce((s, p) => s + changeOf(p), 0));

  useEffect(() => {
    if (!open) return;
    setPayments([]);
    setMethod("CASH");
    setAmountText(String(due));
    setReference("");
    setConfirmingBalance(false);
  }, [open, due]);

  const close = (next: boolean) => {
    if (next || submitting) return;
    if (payments.length && !window.confirm("Close without finishing? The payments entered here are not saved.")) return;
    onOpenChange(false);
  };

  const add = (payment: PosPaymentInput) => {
    if (mode === "collect") return onSubmit([payment]);
    const next = [...payments, payment];
    setPayments(next);
    setReference("");
    const left = round2(due - next.reduce((s, p) => s + p.amount, 0));
    setAmountText(left > 0 ? String(left) : "");
    if (left <= 0) onSubmit(next);
  };

  const entered = Number(amountText);
  const validAmount = amountText !== "" && Number.isFinite(entered) && entered > 0;
  // Cash may be more than is due (that is the change); other methods are capped.
  const applied = validAmount ? round2(Math.min(entered, remaining)) : 0;
  const cashChange = method === "CASH" && validAmount ? round2(Math.max(0, entered - remaining)) : 0;
  const tooMuch = method !== "CASH" && validAmount && entered > remaining + 0.001;

  const take = () => {
    if (!validAmount || tooMuch || applied <= 0 || submitting) return;
    add(
      method === "CASH"
        ? { method, amount: applied, tendered: round2(entered) }
        : { method, amount: applied, reference: reference.trim() || undefined },
    );
  };

  const settled = mode === "sale" && remaining <= 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>{mode === "collect" ? "Collect the balance" : confirmingBalance ? "Finish with a balance due?" : "Take payment"}</DialogTitle>
          <DialogDescription>
            {mode === "collect" ? `${inr(due)} is still due on this bill.` : `Bill ${billRef} · payable ${inr(due)}`}
          </DialogDescription>
        </DialogHeader>

        {confirmingBalance ? (
          <div className="space-y-3">
            <p className="rounded-xl bg-warning-subtle px-4 py-3 text-body text-warning-strong">
              Balance due {inr(remaining)} will be collected later.
            </p>
            <dl className="space-y-1 text-body">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Paid now</dt>
                <dd className="tabular-nums">{inr(paid)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Payable</dt>
                <dd className="tabular-nums">{inr(due)}</dd>
              </div>
            </dl>
            {!hasCustomer && (
              <p className="flex items-start gap-2 text-caption text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                There is no customer on this bill. Adding one makes the balance easier to follow up.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {payments.length > 0 && (
              <ul className="divide-y rounded-xl border">
                {payments.map((p, i) => (
                  <li key={i} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1 text-label">
                      {METHOD_LABEL[p.method]}
                      <span className="block truncate text-caption font-normal text-muted-foreground">
                        {p.method === "CASH" && p.tendered
                          ? `Received ${inr(p.tendered)}${changeOf(p) > 0 ? ` · change ${inr(changeOf(p))}` : ""}`
                          : p.reference || "No reference"}
                      </span>
                    </span>
                    <span className="text-label tabular-nums">{inr(p.amount)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="max-md:size-11"
                      disabled={submitting}
                      aria-label={`Remove the ${METHOD_LABEL[p.method]} payment`}
                      onClick={() => {
                        const next = payments.filter((_, j) => j !== i);
                        setPayments(next);
                        setAmountText(String(round2(due - next.reduce((s, x) => s + x.amount, 0))));
                      }}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {change > 0 && (
              <p className="rounded-xl bg-success-subtle px-4 py-3 text-center text-success">
                <span className="block text-caption">Give back</span>
                <span className="text-stat tabular-nums">{inr(change)}</span>
              </p>
            )}

            {settled ? (
              <p className="flex items-center justify-center gap-2 py-4 text-body text-muted-foreground">
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {submitting ? "Saving the sale…" : "Fully paid."}
              </p>
            ) : (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="text-label text-muted-foreground">{payments.length ? "Left to pay" : "To pay"}</span>
                  <span className="text-subhead tabular-nums">{inr(remaining)}</span>
                </div>

                <div className="grid grid-cols-4 gap-1.5 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Payment method">
                  {METHODS.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={method === id}
                      disabled={submitting}
                      onClick={() => {
                        setMethod(id);
                        setAmountText(String(remaining));
                      }}
                      className={cn(
                        "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg text-caption font-medium transition-colors sm:flex-row sm:gap-1.5",
                        method === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4" />
                      {label}
                    </button>
                  ))}
                </div>

                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    take();
                  }}
                >
                  {method === "UPI" && (
                    <div className="flex flex-col items-center gap-2 rounded-xl border p-3 text-center">
                      {upi ? (
                        validAmount && !tooMuch ? (
                          <>
                            <UpiQr uri={upiPayUri({ upiId: upi.upiId, payeeName: upi.payeeName, amount: applied, note: `Bill ${billRef}` })} label={`UPI QR code for ${inr(applied)}`} />
                            <p className="text-caption text-muted-foreground">
                              Scan with any UPI app to pay <span className="font-medium text-foreground">{inr(applied)}</span> to {upi.upiId}.
                            </p>
                          </>
                        ) : (
                          <p className="py-6 text-caption text-muted-foreground">Enter the amount to show its QR code.</p>
                        )
                      ) : (
                        <p className="py-2 text-caption text-muted-foreground">
                          No UPI ID is set up for this till, so there is no QR code to show. You can still record a UPI payment made to your shop's own QR.{" "}
                          {canManage ? (
                            <Link to="/orders/pos/settings" target="_blank" className="font-medium text-foreground underline underline-offset-2">
                              Add a UPI ID in POS settings
                            </Link>
                          ) : (
                            "A manager can add one in POS settings."
                          )}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="pos-pay-amount">{method === "CASH" ? "Cash received (₹)" : "Amount (₹)"}</Label>
                    <Input
                      id="pos-pay-amount"
                      key={method}
                      autoFocus={finePointer}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={amountText}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setAmountText(e.target.value)}
                      aria-invalid={tooMuch || undefined}
                      className="h-12 text-lg tabular-nums"
                    />
                    {tooMuch && <p className="text-caption text-danger">That is more than the {inr(remaining)} left to pay.</p>}
                  </div>

                  {method === "CASH" && (
                    <div className="flex flex-wrap gap-2">
                      {quickCashAmounts(remaining).map((n, i) => (
                        <Button key={n} type="button" variant="outline" className="h-11 min-w-16 tabular-nums" onClick={() => setAmountText(String(n))}>
                          {i === 0 ? `Exact ${whole(n)}` : whole(n)}
                        </Button>
                      ))}
                    </div>
                  )}

                  {method !== "CASH" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="pos-pay-ref">
                        {method === "UPI" ? "UPI transaction ID (optional)" : method === "CARD" ? "Reference or last 4 digits (optional)" : "Reference (optional)"}
                      </Label>
                      <Input
                        id="pos-pay-ref"
                        value={reference}
                        maxLength={60}
                        autoComplete="off"
                        inputMode={method === "CARD" ? "numeric" : "text"}
                        onChange={(e) => setReference(e.target.value)}
                        className="h-11"
                      />
                    </div>
                  )}

                  {cashChange > 0 && (
                    <p className="flex items-baseline justify-between rounded-xl bg-success-subtle px-4 py-2 text-success">
                      <span className="text-label">Change to give</span>
                      <span className="text-subhead tabular-nums">{inr(cashChange)}</span>
                    </p>
                  )}

                  <Button type="submit" variant="accent" className="h-12 w-full text-body" disabled={!validAmount || tooMuch || applied <= 0 || submitting}>
                    {submitting && <Loader2 className="animate-spin" />}
                    {method === "CASH" ? `Take ${inr(applied)} in cash` : `${METHOD_LABEL[method]} received · ${inr(applied)}`}
                  </Button>
                </form>
              </>
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger-subtle px-3 py-2 text-caption text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1">
              {error}
              <span className="mt-0.5 block text-muted-foreground">The cart and payments are kept, and trying again cannot bill twice.</span>
            </span>
          </div>
        )}

        {mode === "sale" && (
          <DialogFooter>
            {confirmingBalance ? (
              <>
                <Button type="button" variant="outline" disabled={submitting} onClick={() => setConfirmingBalance(false)}>
                  Go back
                </Button>
                <Button type="button" variant="accent" disabled={submitting} onClick={() => onSubmit(payments)}>
                  {submitting && <Loader2 className="animate-spin" />}
                  Finish sale
                </Button>
              </>
            ) : settled ? (
              error && (
                <Button type="button" variant="accent" disabled={submitting} onClick={() => onSubmit(payments)}>
                  {submitting && <Loader2 className="animate-spin" />}
                  Try again
                </Button>
              )
            ) : (
              <Button type="button" variant="ghost" disabled={submitting} onClick={() => setConfirmingBalance(true)}>
                Finish with balance due
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
