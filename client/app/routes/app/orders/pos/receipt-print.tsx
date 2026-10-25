import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { usePosReceipt } from "~/hooks/use-pos-queries";
import { formatDateTime } from "~/lib/format-date";
import { GST_STATES } from "~/lib/pos-cart";
import { formatCurrency } from "~/lib/utils";
import type { PosPaymentMethod, PosReceipt } from "~/types/api";

export function meta() {
  return [{ title: "Receipt | Collabo CRM" }];
}

const METHOD: Record<PosPaymentMethod, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", OTHER: "Other" };
const num = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr = (n: number) => formatCurrency(n, "INR");

function placeOfSupply(value: string | null): string | null {
  if (!value) return null;
  const state = GST_STATES.find((s) => s.code === value);
  return state ? `${state.name} (${state.code})` : value;
}

/**
 * A thermal receipt for 80 mm or 58 mm rolls. Black on white in a monospace
 * face, with nothing carried by colour, because thermal printers print one
 * shade. The page is sized to the receipt's own height so the roll is cut
 * once, below the last line. `?width=58` overrides the store's setting for
 * checking or for a second printer.
 */
export default function PosReceiptPrintPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const [params] = useSearchParams();
  const { data: receipt, isError, refetch } = usePosReceipt(orderId);
  const asked = Number(params.get("width"));
  const width: 58 | 80 = asked === 58 || asked === 80 ? asked : (receipt?.width ?? 80);

  const sheetRef = useRef<HTMLDivElement>(null);
  const [heightMm, setHeightMm] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (sheetRef.current) setHeightMm(Math.ceil((sheetRef.current.offsetHeight * 25.4) / 96) + 4);
  }, [receipt, width]);

  // Print once per receipt, not on every refetch.
  const printedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!receipt || !heightMm || printedRef.current === receipt.order.id) return;
    printedRef.current = receipt.order.id;
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [receipt, heightMm]);

  if (isError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium">This receipt could not be loaded.</p>
        <button onClick={() => void refetch()} className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-medium text-white hover:bg-gray-800">
          Try again
        </button>
      </div>
    );
  }
  if (!receipt) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading receipt…</div>;
  }

  return (
    <div className="min-h-screen bg-neutral-200 py-6 print:bg-white print:py-0">
      <style>{`
        @page { size: ${width}mm ${heightMm ? `${heightMm}mm` : "auto"}; margin: 0; }
        @media print {
          html, body { background: #fff !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print mx-auto mb-4 flex max-w-md flex-wrap items-center justify-center gap-2 px-4 font-sans text-xs">
        <button onClick={() => window.print()} className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-800">
          Print
        </button>
        {([80, 58] as const).map((w) => (
          <Link key={w} to={`?width=${w}`} replace className={`rounded-lg border border-gray-400 px-3 py-2 ${w === width ? "bg-white font-semibold text-black" : "text-gray-700"}`}>
            {w} mm
          </Link>
        ))}
      </div>

      <div ref={sheetRef} className="mx-auto bg-white text-black shadow print:shadow-none" style={{ width: `${width}mm`, padding: width === 80 ? "4mm 4mm 6mm" : "3mm 2.5mm 5mm" }}>
        <Receipt receipt={receipt} narrow={width === 58} />
      </div>
    </div>
  );
}

function Receipt({ receipt: r, narrow }: { receipt: PosReceipt; narrow: boolean }) {
  const igst = r.invoice?.gstType === "INTER" || r.totals.igst > 0;
  const pos = placeOfSupply(r.invoice?.placeOfSupply ?? null);
  return (
    <div className="font-mono leading-snug" style={{ fontSize: narrow ? "9.5pt" : "10.5pt", fontVariantNumeric: "tabular-nums" }}>
      <header className="text-center">
        {r.store.logoUrl && <img src={r.store.logoUrl} alt="" className="mx-auto mb-1 max-h-12 grayscale" />}
        <p className="font-bold" style={{ fontSize: narrow ? "11pt" : "13pt" }}>{r.store.name}</p>
        {r.store.address && <p className="whitespace-pre-line">{r.store.address}</p>}
        {r.store.phone && <p>Phone {r.store.phone}</p>}
        {r.store.gstin && <p>GSTIN {r.store.gstin}</p>}
      </header>

      <Rule />
      <p className="text-center font-bold tracking-wider">{r.invoice ? "TAX INVOICE" : r.balanceDue > 0 ? "BILL" : "RECEIPT"}</p>
      <div className="mt-1">
        {r.invoice && <Pair left="Invoice" right={r.invoice.number} />}
        <Pair left="Order" right={r.order.name} />
        <Pair left="Date" right={formatDateTime(r.invoice?.date ?? r.order.createdAt)} />
        {pos && <Pair left="Place of supply" right={pos} />}
        {r.customer?.name && <Pair left="Customer" right={r.customer.name} />}
        {r.customer?.phone && <Pair left="Mobile" right={r.customer.phone} />}
        {r.customer?.gstin && <Pair left="Customer GSTIN" right={r.customer.gstin} />}
      </div>

      <Rule />
      <Pair left={<span className="font-bold">Item</span>} right={<span className="font-bold">Amount</span>} />
      <Rule light />
      <ul>
        {r.lines.map((l, i) => (
          <li key={i} className="py-0.5">
            <p className="break-words">
              {l.title}
              {l.variantTitle && ` – ${l.variantTitle}`}
            </p>
            <Pair left={`  ${l.quantity} × ${num(l.unitPrice)}`} right={num(round(l.quantity * l.unitPrice))} />
            {l.discount > 0 && <Pair left="  Discount" right={`-${num(l.discount)}`} />}
            {(l.hsn || l.gstRate > 0) && <p className="pl-[2ch]">{[l.hsn && `HSN ${l.hsn}`, `GST ${l.gstRate}%`].filter(Boolean).join(" · ")}</p>}
          </li>
        ))}
      </ul>

      <Rule />
      <Pair left="Subtotal" right={num(r.totals.subtotal)} />
      {r.totals.discount > 0 && <Pair left="Discount" right={`-${num(r.totals.discount)}`} />}
      {r.invoice && <Pair left="Taxable value" right={num(r.totals.taxable)} />}
      {igst ? (
        r.totals.igst > 0 && <Pair left="IGST" right={num(r.totals.igst)} />
      ) : (
        <>
          {r.totals.cgst > 0 && <Pair left="CGST" right={num(r.totals.cgst)} />}
          {r.totals.sgst > 0 && <Pair left="SGST" right={num(r.totals.sgst)} />}
        </>
      )}
      {r.totals.roundOff !== 0 && <Pair left="Round-off" right={`${r.totals.roundOff > 0 ? "+" : "-"}${num(Math.abs(r.totals.roundOff))}`} />}
      <div className="mt-1 border-y-2 border-black py-1 font-bold" style={{ fontSize: narrow ? "11pt" : "12.5pt" }}>
        <Pair left="TOTAL" right={inr(r.totals.payable)} />
      </div>
      {r.totals.cgst + r.totals.sgst + r.totals.igst > 0 && <p className="mt-0.5 text-center">Prices include GST.</p>}

      {r.gstSummary.length > 0 && (
        <>
          <Rule />
          <p className="font-bold">GST summary</p>
          <table className="w-full">
            <thead>
              <tr className="text-right">
                <th className="text-left font-normal">Rate</th>
                <th className="font-normal">Taxable</th>
                {igst ? (
                  <th className="font-normal">IGST</th>
                ) : (
                  <>
                    <th className="font-normal">CGST</th>
                    <th className="font-normal">SGST</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {r.gstSummary.map((g) => (
                <tr key={g.rate} className="text-right">
                  <td className="text-left">{g.rate}%</td>
                  <td>{num(g.taxable)}</td>
                  {igst ? (
                    <td>{num(g.igst)}</td>
                  ) : (
                    <>
                      <td>{num(g.cgst)}</td>
                      <td>{num(g.sgst)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Rule />
      {r.payments.length === 0 ? (
        <p>Not paid yet.</p>
      ) : (
        r.payments.map((p, i) => (
          <div key={i}>
            <Pair left={`Paid by ${METHOD[p.method]}`} right={num(p.amount)} />
            {p.method === "CASH" && p.tendered != null && p.tendered > p.amount && (
              <>
                <Pair left="  Received" right={num(p.tendered)} />
                <Pair left="  Change" right={num(p.change ?? round(p.tendered - p.amount))} />
              </>
            )}
            {p.reference && <p className="break-all pl-[2ch]">Ref {p.reference}</p>}
          </div>
        ))
      )}
      {r.balanceDue > 0 && (
        <div className="mt-1 border border-black px-1 py-0.5 font-bold">
          <Pair left="BALANCE DUE" right={inr(r.balanceDue)} />
        </div>
      )}

      <Rule />
      {r.order.staffName && <p>Billed by {r.order.staffName}</p>}
      {r.order.storeName && r.order.storeName !== r.store.name && <p>{r.order.storeName}</p>}
      {r.footer && <p className="mt-1 whitespace-pre-line text-center">{r.footer}</p>}
      <p className="mt-2 text-center font-bold">Thank you for shopping with us!</p>
    </div>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

function Pair({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 whitespace-pre-wrap break-words">{left}</span>
      <span className="shrink-0 text-right">{right}</span>
    </div>
  );
}

function Rule({ light }: { light?: boolean }) {
  return <hr className={`my-1.5 border-0 border-t border-black ${light ? "" : "border-dashed"}`} />;
}
