import { useEffect, type ReactNode } from "react";
import { useParams } from "react-router";
import { isAxiosError } from "axios";
import { FileX2, Printer, RotateCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { usePublicBill } from "~/hooks/use-pos-queries";
import { formatDateTime } from "~/lib/format-date";
import { GST_STATES } from "~/lib/pos-cart";
import { cn, formatCurrency } from "~/lib/utils";
import type { PosPaymentMethod, PosReceipt } from "~/types/api";

export function meta() {
  return [{ title: "Your bill" }, { name: "robots", content: "noindex" }];
}

const METHOD: Record<PosPaymentMethod, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", OTHER: "Other" };
const inr = (n: number) => formatCurrency(n, "INR");

function placeOfSupply(value: string | null): string | null {
  if (!value) return null;
  const state = GST_STATES.find((s) => s.code === value);
  return state ? `${state.name} (${state.code})` : value;
}

/**
 * The bill a customer opens from the link sent after a sale. Public, outside
 * the app and its sign-in: the token in the link is the only key. The server
 * masks the customer's phone and leaves out their email.
 */
export default function PublicBillPage() {
  const { token } = useParams<{ token: string }>();
  const { data: bill, error, isLoading, refetch, isFetching } = usePublicBill(token);

  useEffect(() => {
    if (bill) document.title = `Bill ${bill.invoice?.number ?? bill.order.name} · ${bill.store.name}`;
  }, [bill]);

  const status = isAxiosError(error) ? (error.response?.status ?? 0) : 0;

  return (
    <div className="min-h-dvh bg-surface-sunken px-0 pb-10 sm:px-4 print:bg-white print:p-0">
      {isLoading ? (
        <div className="mx-auto max-w-xl space-y-3 bg-card p-5 sm:mt-10 sm:rounded-2xl">
          <Skeleton className="mx-auto h-6 w-48" />
          <Skeleton className="mx-auto h-4 w-64" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !bill ? (
        <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-3 px-6 text-center">
          <FileX2 className="size-10 text-muted-foreground" />
          {status >= 400 && status < 500 ? (
            <>
              <h1 className="font-heading text-subhead">This bill link isn't working</h1>
              <p className="text-body text-muted-foreground">It may have expired, or part of it is missing. Ask the store to send the bill again.</p>
            </>
          ) : (
            <>
              <h1 className="font-heading text-subhead">The bill couldn't be loaded</h1>
              <p className="text-body text-muted-foreground">Check your internet connection and try again.</p>
              <Button variant="outline" className="h-11" disabled={isFetching} onClick={() => void refetch()}>
                <RotateCw />
                Try again
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4 py-3 sm:px-0 sm:pt-8 print:hidden">
            <p className="min-w-0 truncate text-caption text-muted-foreground">Your bill from {bill.store.name}</p>
            <Button variant="outline" className="h-11 shrink-0 bg-card" onClick={() => window.print()}>
              <Printer />
              Print / Save as PDF
            </Button>
          </div>
          <Bill bill={bill} />
        </>
      )}
    </div>
  );
}

function Bill({ bill: r }: { bill: PosReceipt }) {
  const igst = r.invoice?.gstType === "INTER" || r.totals.igst > 0;
  const pos = placeOfSupply(r.invoice?.placeOfSupply ?? null);
  const taxed = r.totals.cgst + r.totals.sgst + r.totals.igst > 0;
  return (
    <article className="mx-auto max-w-xl bg-card text-card-foreground shadow-sm ring-1 ring-border sm:rounded-2xl print:max-w-none print:shadow-none print:ring-0">
      <header className="space-y-1 border-b px-5 pt-6 pb-5 text-center">
        {r.store.logoUrl && <img src={r.store.logoUrl} alt="" className="mx-auto mb-2 max-h-14" />}
        <h1 className="font-heading text-subhead">{r.store.name}</h1>
        {r.store.address && <p className="whitespace-pre-line text-caption text-muted-foreground">{r.store.address}</p>}
        <p className="text-caption text-muted-foreground">{[r.store.phone && `Phone ${r.store.phone}`, r.store.gstin && `GSTIN ${r.store.gstin}`].filter(Boolean).join(" · ")}</p>
      </header>

      <section className="space-y-4 border-b px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <span className="rounded-full bg-muted px-2.5 py-1 text-micro font-semibold tracking-wide uppercase">
            {r.invoice ? (r.document.title === "BILL OF SUPPLY" ? "Bill of supply" : "Tax invoice") : r.balanceDue > 0 ? "Bill" : "Receipt"}
          </span>
          <span className="text-caption text-muted-foreground">{formatDateTime(r.invoice?.date ?? r.order.createdAt)}</span>
        </div>
        {r.document.subtitle && <p className="text-caption text-muted-foreground">{r.document.subtitle}</p>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-caption">
          {r.invoice && <Meta label="Invoice number" value={r.invoice.number} mono />}
          <Meta label="Bill number" value={r.order.name} mono />
          {pos && <Meta label="Place of supply" value={pos} />}
          {r.customer && (r.customer.name || r.customer.phone || r.customer.gstin) && (
            <Meta
              label="Billed to"
              value={
                <>
                  {r.customer.name && <span className="block">{r.customer.name}</span>}
                  {r.customer.phone && <span className="block tabular-nums">{r.customer.phone}</span>}
                  {r.customer.gstin && <span className="block font-mono">GSTIN {r.customer.gstin}</span>}
                </>
              }
            />
          )}
        </dl>
      </section>

      <section className="border-b" aria-label="Items">
        <ul className="divide-y">
          {r.lines.map((l, i) => (
            <li key={i} className="flex gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-label">{l.title}</p>
                {l.variantTitle && <p className="text-caption text-muted-foreground">{l.variantTitle}</p>}
                <p className="text-caption text-muted-foreground tabular-nums">
                  {l.quantity} × {inr(l.unitPrice)}
                  {l.discount > 0 && <span className="text-success"> · −{inr(l.discount)} off</span>}
                </p>
                {(l.hsn || l.gstRate > 0) && (
                  <p className="text-micro text-muted-foreground">{[l.hsn && `HSN ${l.hsn}`, `GST ${l.gstRate}%`].filter(Boolean).join(" · ")}</p>
                )}
              </div>
              <p className="shrink-0 text-label tabular-nums">{inr(l.total)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-1 border-b px-5 py-4 text-body" aria-label="Totals">
        <Pair label="Subtotal" value={inr(r.totals.subtotal)} />
        {r.totals.discount > 0 && <Pair label="Discount" value={`−${inr(r.totals.discount)}`} />}
        {r.invoice && <Pair label="Taxable value" value={inr(r.totals.taxable)} muted />}
        {igst ? (
          r.totals.igst > 0 && <Pair label="IGST" value={inr(r.totals.igst)} muted />
        ) : (
          <>
            {r.totals.cgst > 0 && <Pair label="CGST" value={inr(r.totals.cgst)} muted />}
            {r.totals.sgst > 0 && <Pair label="SGST" value={inr(r.totals.sgst)} muted />}
          </>
        )}
        {r.totals.roundOff !== 0 && <Pair label="Round-off" value={`${r.totals.roundOff > 0 ? "+" : "−"}${inr(Math.abs(r.totals.roundOff))}`} muted />}
        <div className="mt-2 flex items-baseline justify-between border-t pt-3">
          <span className="text-section">Total</span>
          <span className="font-heading text-subhead tabular-nums">{inr(r.totals.payable)}</span>
        </div>
        {taxed && <p className="text-caption text-muted-foreground">Prices include GST.</p>}
      </section>

      {r.gstSummary.length > 0 && (
        <section className="border-b px-5 py-4" aria-label="GST summary">
          <h2 className="mb-2 text-label">GST summary</h2>
          <table className="w-full text-caption tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="text-right">
                <th className="py-1 text-left font-normal">Rate</th>
                <th className="py-1 font-normal">Taxable</th>
                {igst ? (
                  <th className="py-1 font-normal">IGST</th>
                ) : (
                  <>
                    <th className="py-1 font-normal">CGST</th>
                    <th className="py-1 font-normal">SGST</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {r.gstSummary.map((g) => (
                <tr key={g.rate} className="border-t text-right">
                  <td className="py-1.5 text-left">{g.rate}%</td>
                  <td className="py-1.5">{inr(g.taxable)}</td>
                  {igst ? (
                    <td className="py-1.5">{inr(g.igst)}</td>
                  ) : (
                    <>
                      <td className="py-1.5">{inr(g.cgst)}</td>
                      <td className="py-1.5">{inr(g.sgst)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="space-y-2 border-b px-5 py-4" aria-label="Payments">
        <h2 className="text-label">Payment</h2>
        {r.payments.length === 0 ? (
          <p className="text-caption text-muted-foreground">Not paid yet.</p>
        ) : (
          <ul className="space-y-1.5 text-body">
            {r.payments.map((p, i) => (
              <li key={i}>
                <Pair label={`Paid by ${METHOD[p.method]}`} value={inr(p.amount)} />
                {p.method === "CASH" && p.tendered != null && p.tendered > p.amount && (
                  <p className="text-caption text-muted-foreground tabular-nums">
                    Received {inr(p.tendered)} · change {inr(p.change ?? Math.round((p.tendered - p.amount) * 100) / 100)}
                  </p>
                )}
                {p.reference && <p className="break-all text-caption text-muted-foreground">Reference {p.reference}</p>}
              </li>
            ))}
          </ul>
        )}
        {r.balanceDue > 0 && (
          <div className="flex items-baseline justify-between rounded-xl bg-warning-subtle px-3 py-2 text-warning-strong">
            <span className="text-label">Balance due</span>
            <span className="text-section tabular-nums">{inr(r.balanceDue)}</span>
          </div>
        )}
      </section>

      <footer className="space-y-1 px-5 py-5 text-center text-caption text-muted-foreground">
        {r.footer && <p className="whitespace-pre-line text-foreground">{r.footer}</p>}
        {r.order.staffName && <p>Billed by {r.order.staffName}{r.order.storeName && r.order.storeName !== r.store.name ? ` at ${r.order.storeName}` : ""}</p>}
        <p className="pt-2 font-medium text-foreground">Thank you for shopping with us!</p>
      </footer>
    </article>
  );
}

function Meta({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("break-words font-medium", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function Pair({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", muted && "text-muted-foreground")}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
