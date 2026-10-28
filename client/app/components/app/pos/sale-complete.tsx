import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, CheckCheck, CheckCircle2, CircleDollarSign, Clock, Copy, Loader2, MessageCircle, Plus, Printer, RotateCw, Send, Share2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { useSendPosBillMutation } from "~/hooks/use-pos-mutations";
import { deliveryInFlight, usePosDelivery } from "~/hooks/use-pos-queries";
import { serverMessage } from "~/lib/handle-mutation-error";
import { formatPhone, INDIAN_MOBILE, nationalDigits } from "~/lib/pos-cart";
import { cn, formatCurrency } from "~/lib/utils";
import type { PosBillDelivery, PosBillState, PosSaleResult, PosSetup } from "~/types/api";

const inr = (n: number) => formatCurrency(n, "INR");

/**
 * Payment done (the whole screen on a phone): the change to give or what was
 * paid, the order and invoice, and how the bill reached the customer. New
 * sale never waits for the bill.
 */
export function SaleComplete({
  result,
  storeName,
  whatsapp,
  canManage,
  staffToken,
  onStaffRefused,
  onPrint,
  onCollect,
  onNewSale,
}: {
  result: PosSaleResult;
  storeName: string;
  whatsapp: PosSetup["billDelivery"]["whatsapp"];
  canManage: boolean;
  /** Sent with Retry and Change number, as with the sale. */
  staffToken: string | undefined;
  /** True when it handled a refused staff token (the till asks for a PIN again). */
  onStaffRefused: (error: unknown) => boolean;
  onPrint: () => void;
  onCollect: () => void;
  onNewSale: () => void;
}) {
  const due = result.balanceDue > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background md:bg-transparent">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-[max(24px,env(safe-area-inset-top))] pb-6 md:py-8">
        <div className="mx-auto w-full max-w-md space-y-5">
          <div className="space-y-1 text-center">
            {due ? <Clock className="mx-auto size-11 text-warning" /> : <CheckCircle2 className="mx-auto size-11 text-success" />}
            <h2 className="font-heading text-subhead">{due ? "Saved with a balance due" : "Payment received"}</h2>
            <p className="text-body text-muted-foreground">
              Order {result.orderName}
              {result.invoiceNumber && ` · Invoice ${result.invoiceNumber}`}
            </p>
          </div>

          {result.change > 0 ? (
            <div className="rounded-2xl bg-success-subtle px-6 py-4 text-center text-success">
              <p className="text-label">Change to give back</p>
              <p className="font-heading text-[44px] leading-tight font-semibold tabular-nums">{inr(result.change)}</p>
              <p className="text-caption">{inr(result.payable)} bill</p>
            </div>
          ) : (
            <div className="rounded-2xl bg-muted px-6 py-4 text-center">
              <p className="text-label text-muted-foreground">{due ? "Balance due" : "Paid"}</p>
              <p className="font-heading text-[44px] leading-tight font-semibold tabular-nums">{inr(due ? result.balanceDue : result.paid)}</p>
              {due && <p className="text-caption text-muted-foreground">{inr(result.paid)} paid of {inr(result.payable)}</p>}
            </div>
          )}

          <BillCard
            key={result.orderId}
            orderId={result.orderId}
            orderName={result.orderName}
            initial={{ billUrl: result.billUrl, delivery: result.delivery }}
            storeName={storeName}
            whatsapp={whatsapp}
            canManage={canManage}
            staffToken={staffToken}
            onStaffRefused={onStaffRefused}
            onPrint={onPrint}
          />

          {due && (
            <Button type="button" variant="outline" className="h-12 w-full" onClick={onCollect}>
              <CircleDollarSign />
              Collect the balance now
            </Button>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:border-0 md:pb-6">
        <Button type="button" variant="accent" className="mx-auto flex h-14 w-full max-w-md rounded-xl text-section" autoFocus onClick={onNewSale}>
          <Plus />
          New sale
        </Button>
      </div>
    </div>
  );
}

const STATUS: Record<PosBillDelivery["status"], { label: string; tone: string }> = {
  sending: { label: "Sending…", tone: "text-muted-foreground" },
  sent: { label: "Sent", tone: "text-foreground" },
  delivered: { label: "Delivered", tone: "text-success-text" },
  read: { label: "Read", tone: "text-info-text" },
  not_sent: { label: "Not sent", tone: "text-danger-text" },
  failed: { label: "Not sent", tone: "text-danger-text" },
};

const failed = (d: PosBillDelivery) => d.status === "not_sent" || d.status === "failed";

/** How the bill went out, live: polled while a message is on its way, with Retry and Change number. */
function BillCard({
  orderId,
  orderName,
  initial,
  storeName,
  whatsapp,
  canManage,
  staffToken,
  onStaffRefused,
  onPrint,
}: {
  orderId: string;
  orderName: string;
  initial: PosBillState;
  storeName: string;
  whatsapp: PosSetup["billDelivery"]["whatsapp"];
  canManage: boolean;
  staffToken: string | undefined;
  onStaffRefused: (error: unknown) => boolean;
  onPrint: () => void;
}) {
  const [attempt, setAttempt] = useState(() => ({ initial, since: Date.now() }));
  const { data: bill, refetch, isFetching } = usePosDelivery(orderId, attempt.initial, attempt.since);
  const send = useSendPosBillMutation();
  const [sendError, setSendError] = useState<string | null>(null);
  const [numberOpen, setNumberOpen] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  // Polling stops after a minute; a message still "sending" then gets a manual check.
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    setGaveUp(false);
    const t = setTimeout(() => setGaveUp(true), 60_000);
    return () => clearTimeout(t);
  }, [attempt.since]);

  const resend = (phone?: string) => {
    setSendError(null);
    send.mutate(
      { orderId, phone, staffToken },
      {
        onSuccess: (next) => {
          setAttempt({ initial: next, since: Date.now() });
          setNumberOpen(false);
        },
        onError: (error) => {
          if (!onStaffRefused(error)) setSendError(serverMessage(error, "The bill was not sent. Check the connection and try again."));
        },
      },
    );
  };

  const to = bill.delivery.find((d) => d.to)?.to ?? null;
  const waDigits = to ? to.replace(/\D/g, "") : null;
  const share = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `Bill ${orderName} from ${storeName}`, url: bill.billUrl });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(bill.billUrl);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <section className="rounded-2xl border bg-card" aria-label="Bill">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h3 className="text-section">Bill</h3>
        {deliveryInFlight(bill) && !gaveUp && <span className="text-caption text-muted-foreground">Updating…</span>}
      </div>

      <div className="space-y-3 px-4 py-3">
        {bill.delivery.length > 0 ? (
          <ul className="space-y-3">
            {bill.delivery.map((d) => (
              <li key={d.channel} className="flex gap-3">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-success-subtle text-success">
                  <MessageCircle className="size-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-label">WhatsApp</span>
                    <span className={cn("flex items-center gap-1 text-label", STATUS[d.status].tone)} role="status">
                      {d.status === "sending" && <Loader2 className="size-3.5 animate-spin" />}
                      {d.status === "sent" && <Check className="size-4" />}
                      {(d.status === "delivered" || d.status === "read") && <CheckCheck className="size-4" />}
                      {STATUS[d.status].label}
                    </span>
                  </div>
                  {d.to && <p className="text-caption text-muted-foreground tabular-nums">{formatPhone(d.to)}</p>}
                  {failed(d) && <p className="text-caption text-danger">{d.reason ?? "Bill not sent."}</p>}
                  {d.status === "sending" && gaveUp && (
                    <p className="text-caption text-muted-foreground">
                      This is taking longer than usual.{" "}
                      <button type="button" className="font-medium text-foreground underline underline-offset-2" disabled={isFetching} onClick={() => void refetch()}>
                        Check again
                      </button>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {failed(d) && (
                      <Button type="button" variant="outline" className="h-11" disabled={send.isPending} onClick={() => resend()}>
                        {send.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
                        Retry
                      </Button>
                    )}
                    {d.status !== "sending" && (
                      <Button type="button" variant={failed(d) ? "outline" : "ghost"} className={cn("h-11", !failed(d) && "-ml-2.5 text-muted-foreground")} disabled={send.isPending} onClick={() => setNumberOpen(true)}>
                        Change number
                      </Button>
                    )}
                    {failed(d) && canManage && !whatsapp.connected && (
                      <Button asChild variant="link" className="h-11 px-1 underline underline-offset-2">
                        <Link to="/settings/channels">Connect WhatsApp</Link>
                      </Button>
                    )}
                    {failed(d) && canManage && whatsapp.connected && whatsapp.template !== "approved" && (
                      <Button asChild variant="link" className="h-11 px-1 underline underline-offset-2">
                        <Link to="/campaigns/templates">Bill template</Link>
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          // The server sends no rows only when the sale had no mobile number.
          <div className="space-y-2">
            <p className="text-body text-muted-foreground">No mobile number, so the bill wasn't sent.</p>
            <Button type="button" variant="outline" className="h-11" disabled={send.isPending} onClick={() => setNumberOpen(true)}>
              <Send />
              Send bill
            </Button>
          </div>
        )}
        {sendError && !numberOpen && <p className="text-caption text-danger" role="alert">{sendError}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t px-4 py-3">
        <Button type="button" variant="outline" className="h-12" onClick={() => void share()}>
          <Share2 />
          Share bill
        </Button>
        <Button type="button" variant="outline" className="h-12" onClick={onPrint}>
          <Printer />
          Print receipt
        </Button>
        {copied && (
          <div className="col-span-2 space-y-2 text-caption" role="status">
            {copied === "copied" ? (
              <p className="flex items-center gap-1.5 text-success">
                <Copy className="size-3.5" />
                Link copied.
              </p>
            ) : (
              <p className="break-all text-muted-foreground">
                Copy this link: <span className="font-mono text-foreground select-all">{bill.billUrl}</span>
              </p>
            )}
            {waDigits && (
              <Button asChild variant="outline" className="h-11 w-full">
                <a href={`https://wa.me/${waDigits}?text=${encodeURIComponent(bill.billUrl)}`} target="_blank" rel="noopener noreferrer">
                  <MessageCircle />
                  Open in WhatsApp
                </a>
              </Button>
            )}
          </div>
        )}
      </div>

      <SendBillSheet
        open={numberOpen}
        onOpenChange={(open) => {
          setNumberOpen(open);
          if (!open) setSendError(null);
        }}
        initial={nationalDigits(to)}
        pending={send.isPending}
        error={sendError}
        onSend={(digits) => resend(`+91${digits}`)}
      />
    </section>
  );
}

/** A small sheet for the number to send the bill to. */
function SendBillSheet({
  open,
  onOpenChange,
  initial,
  pending,
  error,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string;
  pending: boolean;
  error: string | null;
  onSend: (digits: string) => void;
}) {
  const [digits, setDigits] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDigits(initial);
    setAttempted(false);
  }, [open, initial]);
  const valid = INDIAN_MOBILE.test(digits);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Send the bill</DialogTitle>
          <DialogDescription>The bill goes to this number on WhatsApp.</DialogDescription>
        </DialogHeader>
        <form
          id="pos-send-bill"
          className="space-y-1.5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setAttempted(true);
            if (valid && !pending) onSend(digits);
          }}
        >
          <Label htmlFor="pos-send-bill-phone">Mobile number</Label>
          <div className="flex h-12 items-stretch overflow-hidden rounded-xl border border-input bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
            <span className="flex items-center border-r bg-muted px-3 text-body font-medium text-muted-foreground">+91</span>
            <input
              id="pos-send-bill-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              autoFocus
              value={digits}
              placeholder="98470 12345"
              aria-invalid={(attempted && !valid) || undefined}
              onChange={(e) => {
                let d = e.target.value.replace(/\D/g, "");
                if (d.length > 10) d = d.replace(/^(91|0)/, "");
                setDigits(d.slice(0, 10));
              }}
              className="min-w-0 flex-1 bg-transparent px-3 text-lg tracking-wide tabular-nums outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          {attempted && !valid && <p className="text-caption text-danger">Enter a 10-digit mobile number that starts with 6, 7, 8 or 9.</p>}
          {error && <p className="text-caption text-danger" role="alert">{error}</p>}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="pos-send-bill" variant="accent" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Send />}
            Send bill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
