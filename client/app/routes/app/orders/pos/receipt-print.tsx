import "@fontsource/noto-sans/400.css";
import "@fontsource/noto-sans/700.css";
import "@fontsource/noto-sans-devanagari/400.css";
import "@fontsource/noto-sans-devanagari/700.css";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import QRCode from "qrcode";
import { usePosReceipt } from "~/hooks/use-pos-queries";
import { GST_STATES } from "~/lib/pos-cart";
import {
  computerGeneratedNote,
  contactParts,
  customerLine,
  gstSummaryTotal,
  hasTaxCodes,
  itemCount,
  legalNameLine,
  lineDetail,
  lineName,
  qrCaption,
  rollAmount,
  rollDateTime,
  showsPlaceOfSupply,
  taxHeads,
} from "~/lib/receipt";
import { formatCurrency } from "~/lib/utils";
import { posService } from "~/services/pos.service";
import type { PosPaymentMethod, PosReceipt } from "~/types/api";

export function meta() {
  return [{ title: "Receipt | Collabo CRM" }];
}

const METHOD: Record<PosPaymentMethod, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", OTHER: "Other" };
const inr = (n: number) => formatCurrency(n, "INR");
const round = (n: number) => Math.round(n * 100) / 100;
/** Prints ₹ and Hindi names; a proportional face fits more on a line than monospace. */
const RECEIPT_FONT = '"Noto Sans", "Noto Sans Devanagari", sans-serif';

/** Type sizes per roll: the body, the GST table, the store's name, the title and the net payable. */
const SIZES = {
  80: { body: "8.5pt", small: "7.5pt", name: "12pt", title: "9.5pt", net: "11pt" },
  58: { body: "8pt", small: "7pt", name: "11pt", title: "9pt", net: "10pt" },
};

function placeOfSupply(value: string): string {
  const state = GST_STATES.find((s) => s.code === value);
  return state ? `${state.name} (${state.code})` : value;
}

/** The QR as an image. Dark on white, always: payment and camera apps misread an inverted code. */
function useQrImage(text: string | null): string | null {
  const [image, setImage] = useState<{ text: string; src: string } | null>(null);
  useEffect(() => {
    if (!text) return;
    let live = true;
    void QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 512, color: { dark: "#000000", light: "#ffffff" } }).then((src) => {
      if (live) setImage({ text, src });
    });
    return () => {
      live = false;
    };
  }, [text]);
  return image && image.text === text ? image.src : null;
}

/**
 * A thermal receipt for 80 mm or 58 mm rolls: 72 mm and 48 mm of print, the
 * widths generic printers reach. Black on white in Noto Sans, with nothing
 * carried by colour, because thermal printers print one shade. The page is
 * sized to the receipt's own height so the roll is cut once, below the last
 * line, and it is printed only once the fonts, the logo and the QR code are
 * in, so the height is measured on what prints. `?width=58` overrides the store's
 * setting for checking or for a second printer.
 */
export default function PosReceiptPrintPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const [params] = useSearchParams();
  const { data: receipt, isError, refetch } = usePosReceipt(orderId);
  const asked = Number(params.get("width"));
  const width: 58 | 80 = asked === 58 || asked === 80 ? asked : (receipt?.width ?? 80);

  // Printed from this page already: the next print is a duplicate too.
  const [printedHere, setPrintedHere] = useState(false);
  const duplicate = !!receipt?.printedBefore || printedHere;

  const qrText = receipt?.qr ? (receipt.qr.kind === "ebill" ? receipt.qr.url : receipt.qr.uri) : null;
  const qrImage = useQrImage(qrText);

  const [fontsIn, setFontsIn] = useState(false);
  useEffect(() => {
    if (!receipt) return;
    let live = true;
    const faces = ['400 12px "Noto Sans"', '700 12px "Noto Sans"'].map((face) => document.fonts.load(face, "₹ Aa1"));
    void Promise.all(faces)
      .then(() => document.fonts.ready)
      .finally(() => live && setFontsIn(true));
    return () => {
      live = false;
    };
  }, [receipt]);
  // The logo has no fixed height, so the page is measured after it loads (or fails, and is left out).
  const logoUrl = receipt?.store.logoUrl ?? null;
  const [logo, setLogo] = useState<{ url: string; ok: boolean } | null>(null);
  const logoSettled = !logoUrl || logo?.url === logoUrl;
  const ready = !!receipt && fontsIn && logoSettled && (!qrText || !!qrImage);

  const sheetRef = useRef<HTMLDivElement>(null);
  const [heightMm, setHeightMm] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (ready && sheetRef.current) setHeightMm(Math.ceil((sheetRef.current.offsetHeight * 25.4) / 96) + 4);
  }, [ready, receipt, width, duplicate, qrImage, logo]);

  // Print once per receipt, not on every refetch. Any print marks it (the
  // button, Ctrl+P), so a re-measure just before the dialog only moves the
  // timer, and a print the cashier started first stops this one.
  const printedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!receipt) return;
    const mark = () => {
      printedRef.current = receipt.order.id;
    };
    window.addEventListener("beforeprint", mark);
    return () => window.removeEventListener("beforeprint", mark);
  }, [receipt]);
  useEffect(() => {
    if (!receipt || !ready || !heightMm || printedRef.current === receipt.order.id) return;
    const id = receipt.order.id;
    const t = setTimeout(() => {
      if (printedRef.current === id) return;
      printedRef.current = id;
      window.print();
    }, 300);
    return () => clearTimeout(t);
  }, [receipt, ready, heightMm]);

  // The first print is recorded when its dialog closes, so a reprint, here or
  // from a fresh page, says DUPLICATE. Browsers can't tell a cancelled dialog
  // from a printed one, so a cancel counts too.
  useEffect(() => {
    if (!receipt || receipt.printedBefore) return;
    const record = () => {
      setPrintedHere(true);
      // Losing this only drops the mark from a later reprint; the print itself happened.
      void posService.markReceiptPrinted(receipt.order.id).catch(() => undefined);
    };
    window.addEventListener("afterprint", record, { once: true });
    return () => window.removeEventListener("afterprint", record);
  }, [receipt]);

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
        <button onClick={() => window.print()} disabled={!ready} className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-800 disabled:opacity-50">
          Print
        </button>
        {([80, 58] as const).map((w) => (
          <Link key={w} to={`?width=${w}`} replace className={`rounded-lg border border-gray-400 px-3 py-2 ${w === width ? "bg-white font-semibold text-black" : "text-gray-700"}`}>
            {w} mm
          </Link>
        ))}
      </div>

      <div
        ref={sheetRef}
        className="mx-auto bg-white text-black shadow print:shadow-none"
        style={{ width: `${width}mm`, padding: width === 80 ? "4mm 4mm 6mm" : "3mm 5mm 5mm" }}
      >
        <Receipt
          receipt={receipt}
          narrow={width === 58}
          duplicate={duplicate}
          qrImage={qrImage}
          logoUrl={logoUrl && logo?.ok !== false ? logoUrl : null}
          onLogo={(ok) => logoUrl && setLogo({ url: logoUrl, ok })}
        />
      </div>
    </div>
  );
}

function Receipt({
  receipt: r,
  narrow,
  duplicate,
  qrImage,
  logoUrl,
  onLogo,
}: {
  receipt: PosReceipt;
  narrow: boolean;
  duplicate: boolean;
  qrImage: string | null;
  /** Null when there is none, or it failed to load and is left out. */
  logoUrl: string | null;
  onLogo: (loaded: boolean) => void;
}) {
  const size = SIZES[narrow ? 58 : 80];
  const igst = taxHeads(r) === "IGST";
  const codes = hasTaxCodes(r.lines);
  const taxed = r.totals.cgst + r.totals.sgst + r.totals.igst > 0;
  const legal = legalNameLine(r.store);
  const contact = contactParts(r.store);
  const customer = customerLine(r.customer);
  const pos = showsPlaceOfSupply(r) ? placeOfSupply(r.invoice!.placeOfSupply!) : null;
  const where = r.order.storeName && r.order.storeName !== r.store.name ? r.order.storeName : null;
  const orderLine = [r.invoice && `Order ${r.order.name}`, where].filter(Boolean).join(" · ");
  const summary = gstSummaryTotal(r.gstSummary);

  return (
    <div className="leading-snug" style={{ fontFamily: RECEIPT_FONT, fontSize: size.body, fontVariantNumeric: "tabular-nums" }}>
      <header className="text-center">
        {logoUrl && (
          <img
            src={logoUrl}
            alt=""
            onLoad={() => onLogo(true)}
            onError={() => onLogo(false)}
            className="mx-auto mb-1 object-contain grayscale"
            style={{ maxWidth: "48mm", maxHeight: "12mm" }}
          />
        )}
        <p className="font-bold" style={{ fontSize: size.name, letterSpacing: "0.04em" }}>
          {r.store.name}
        </p>
        {legal && <p>{legal}</p>}
        {r.store.address && <p className="whitespace-pre-line">{r.store.address}</p>}
        {contact.length > 0 && <Units parts={contact} />}
        {r.store.gstin && <p className="font-bold">GSTIN {r.store.gstin}</p>}
        {r.store.ids.length > 0 && <Units parts={r.store.ids.map((id) => `${id.label} ${id.value}`)} />}
      </header>

      <Rule />
      <p className="text-center font-bold" style={{ fontSize: size.title, letterSpacing: "0.12em" }}>
        {r.document.title}
      </p>
      {r.document.subtitle && (
        <p className="text-center" style={{ fontSize: size.small }}>
          {r.document.subtitle}
        </p>
      )}
      {duplicate && <p className="mx-auto my-1 w-fit border border-black px-2 font-bold tracking-widest">DUPLICATE</p>}
      <div className="mt-1">
        <Pair wrap left={`Bill No: ${r.invoice?.number ?? r.order.name}`} right={rollDateTime(r.invoice?.date ?? r.order.createdAt)} />
        {(orderLine || r.order.staffName) && <Pair wrap left={orderLine} right={r.order.staffName ? `Cashier: ${r.order.staffName}` : ""} />}
        {customer && <p>{customer}</p>}
        {r.customer?.gstin && <p>Customer GSTIN {r.customer.gstin}</p>}
        {pos && <p>Place of supply: {pos}</p>}
      </div>

      <Rule />
      <Pair
        left={<span className="font-bold">Item</span>}
        right={
          <span className="flex gap-3 font-bold">
            {codes && <span>GST</span>}
            <span>Amount</span>
          </span>
        }
      />
      <Rule />
      <ul>
        {r.lines.map((l, i) => (
          <li key={i} className="py-0.5">
            <Pair left={lineName(l, i)} right={l.taxCode ?? ""} />
            <Pair indent left={lineDetail(l)} right={rollAmount(round(l.quantity * l.unitPrice))} />
            {l.discount > 0 && <Pair indent left="Discount" right={rollAmount(-l.discount)} />}
          </li>
        ))}
      </ul>

      <Rule />
      <p>{itemCount(r.lines)}</p>
      <Pair left="Subtotal" right={rollAmount(r.totals.subtotal)} />
      {r.totals.discount > 0 && <Pair left="Less discount" right={rollAmount(-r.totals.discount)} />}
      {r.totals.roundOff !== 0 && (
        <Pair left="Round off" right={`${r.totals.roundOff > 0 ? "+" : "−"}${rollAmount(Math.abs(r.totals.roundOff))}`} />
      )}
      <div className="mt-1 border-y-2 border-black py-0.5 font-bold" style={{ fontSize: size.net }}>
        <Pair left="NET PAYABLE" right={inr(r.totals.payable)} />
      </div>
      {taxed && <p className="mt-0.5 text-center">Prices include GST.{r.gstSummary.length > 0 && " GST details below."}</p>}

      <Rule />
      {r.payments.length === 0 ? (
        <p>Not paid yet.</p>
      ) : (
        r.payments.map((p, i) => (
          <div key={i}>
            <Pair left={`Paid by ${METHOD[p.method]}`} right={rollAmount(p.amount)} />
            {p.reference && <p className="break-all pl-[2ch]">Ref {p.reference}</p>}
            {p.method === "CASH" && p.tendered != null && p.tendered > p.amount && (
              <p className="pl-[2ch]">
                Received {rollAmount(p.tendered)} · Change {rollAmount(p.change ?? round(p.tendered - p.amount))}
              </p>
            )}
          </div>
        ))
      )}
      {r.balanceDue > 0 && (
        <div className="mt-1 border-2 border-black px-1 py-0.5 font-bold" style={{ fontSize: size.net }}>
          <Pair left="BALANCE DUE" right={inr(r.balanceDue)} />
        </div>
      )}

      {r.gstSummary.length > 0 && (
        <>
          <Rule />
          <p className="font-bold">GST SUMMARY</p>
          <table className="w-full" style={{ fontSize: size.small }}>
            <thead>
              <tr className="text-right">
                <th className="text-left font-bold">Code</th>
                <th className="text-left font-bold">Rate</th>
                <th className="font-bold">Taxable</th>
                {igst ? (
                  <th className="font-bold">IGST</th>
                ) : (
                  <>
                    <th className="font-bold">CGST</th>
                    <th className="font-bold">SGST</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {r.gstSummary.map((g) => (
                <tr key={g.code} className="text-right">
                  <td className="text-left">{g.code}</td>
                  <td className="text-left">{g.rate}%</td>
                  <td>{rollAmount(g.taxable)}</td>
                  {igst ? (
                    <td>{rollAmount(g.igst)}</td>
                  ) : (
                    <>
                      <td>{rollAmount(g.cgst)}</td>
                      <td>{rollAmount(g.sgst)}</td>
                    </>
                  )}
                </tr>
              ))}
              <tr className="text-right font-bold">
                <td className="text-left" colSpan={2}>
                  Total
                </td>
                <td>{rollAmount(summary.taxable)}</td>
                {igst ? (
                  <td>{rollAmount(summary.igst)}</td>
                ) : (
                  <>
                    <td>{rollAmount(summary.cgst)}</td>
                    <td>{rollAmount(summary.sgst)}</td>
                  </>
                )}
              </tr>
            </tbody>
          </table>
        </>
      )}

      {r.qr && qrImage && (
        <>
          <Rule />
          <div className="text-center">
            <img src={qrImage} alt="" className="mx-auto" style={{ width: "22mm", height: "22mm", imageRendering: "pixelated" }} />
            <p>{qrCaption(r.qr)}</p>
          </div>
        </>
      )}

      <Rule />
      <footer className="text-center">
        {r.returnPolicy && <p>{r.returnPolicy}</p>}
        {r.footer && <p className="whitespace-pre-line">{r.footer}</p>}
        <p>{computerGeneratedNote(r.document.title)}</p>
        <p className="mt-1.5 font-bold">Thank you! Visit again.</p>
      </footer>
    </div>
  );
}

/**
 * Text on the left, an amount or a code on the right. `wrap` moves the right
 * side under the left when both don't fit, as a bill number and its date
 * don't on 58 mm paper, rather than breaking the number.
 */
function Pair({ left, right, indent, wrap }: { left: ReactNode; right: ReactNode; indent?: boolean; wrap?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-x-2 ${wrap ? "flex-wrap" : ""} ${indent ? "pl-[2ch]" : ""}`}>
      <span className="min-w-0 whitespace-pre-wrap break-words">{left}</span>
      <span className="ml-auto shrink-0 text-right">{right}</span>
    </div>
  );
}

/** "Ph … · WhatsApp …": each part kept whole, so a narrow roll breaks between them. */
function Units({ parts }: { parts: string[] }) {
  return (
    <p>
      {parts.map((part, i) => (
        <span key={part}>
          {i > 0 && " · "}
          <span className="whitespace-nowrap">{part}</span>
        </span>
      ))}
    </p>
  );
}

function Rule() {
  return <hr className="my-1.5 border-0 border-t border-dashed border-black" />;
}
