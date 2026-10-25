import { CheckCircle2, CircleDollarSign, Clock, Loader2, MessageCircle, Plus, Printer } from "lucide-react";
import { Button } from "~/components/ui/button";
import { formatCurrency } from "~/lib/utils";
import type { PosSaleResult } from "~/types/api";

const inr = (n: number) => formatCurrency(n, "INR");

/** After the sale: the server's numbers, the change to give back, and what to do next. */
export function SaleComplete({
  result,
  sending,
  sent,
  whatsappRefused,
  onPrint,
  onWhatsApp,
  onCollect,
  onNewSale,
}: {
  result: PosSaleResult;
  sending: boolean;
  sent: boolean;
  /** Why the server would not send it, shown in place of the button. */
  whatsappRefused: string | null;
  onPrint: () => void;
  onWhatsApp: () => void;
  onCollect: () => void;
  onNewSale: () => void;
}) {
  const due = result.balanceDue > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-8 md:justify-center">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-2">
          {due ? <Clock className="mx-auto size-12 text-warning" /> : <CheckCircle2 className="mx-auto size-12 text-success" />}
          <h2 className="font-heading text-page-title">{due ? "Saved with a balance due" : "Sale complete"}</h2>
          <p className="text-body text-muted-foreground">
            Order {result.orderName}
            {result.invoiceNumber && ` · Invoice ${result.invoiceNumber}`}
          </p>
        </div>

        {result.change > 0 ? (
          <div className="rounded-2xl bg-success-subtle px-6 py-5 text-success">
            <p className="text-label">Change to give back</p>
            <p className="font-heading text-[44px] font-semibold leading-tight tabular-nums">{inr(result.change)}</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-muted px-6 py-5">
            <p className="text-label text-muted-foreground">{due ? "Balance due" : "Paid"}</p>
            <p className="font-heading text-[44px] font-semibold leading-tight tabular-nums">{inr(due ? result.balanceDue : result.paid)}</p>
          </div>
        )}

        <dl className="grid grid-cols-3 gap-2 text-left">
          <Stat label="Payable" value={inr(result.payable)} />
          <Stat label="Paid" value={inr(result.paid)} />
          <Stat label={due ? "Balance due" : "Round-off"} value={due ? inr(result.balanceDue) : `${result.roundOff < 0 ? "−" : result.roundOff > 0 ? "+" : ""}${inr(Math.abs(result.roundOff))}`} />
        </dl>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="outline" className="h-12" onClick={onPrint}>
            <Printer />
            Print receipt
          </Button>
          {result.whatsapp.canSend && !whatsappRefused ? (
            <Button type="button" variant="outline" className="h-12" disabled={sending || sent} onClick={onWhatsApp}>
              {sending ? <Loader2 className="animate-spin" /> : <MessageCircle />}
              {sent ? "Sent on WhatsApp" : "Send on WhatsApp"}
            </Button>
          ) : (
            <p className="flex items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2 text-caption text-muted-foreground">
              <MessageCircle className="size-4 shrink-0" />
              {whatsappRefused ?? result.whatsapp.reason ?? "This receipt cannot be sent on WhatsApp."}
            </p>
          )}
          {due && (
            <Button type="button" variant="outline" className="h-12 sm:col-span-2" onClick={onCollect}>
              <CircleDollarSign />
              Collect the balance now
            </Button>
          )}
        </div>

        <Button type="button" variant="accent" className="h-14 w-full rounded-xl text-section" autoFocus onClick={onNewSale}>
          <Plus />
          New sale
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border px-3 py-2">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-label tabular-nums">{value}</dd>
    </div>
  );
}
