import type { PosReceipt } from "~/types/api";

/**
 * The till receipt's wording and sums, apart from its layout
 * (routes/app/orders/pos/receipt-print.tsx). The server decides what the
 * receipt says; these only put it into the receipt's words.
 *
 * Type-only imports, so `node --test` runs this file as it is.
 */

type Line = PosReceipt["lines"][number];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "1,299.00": Indian grouping, and a true minus sign. */
export function rollAmount(n: number): string {
  const digits = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `−${digits}` : digits;
}

/** "27-10-2026 14:05", in the till's own time. */
export function rollDateTime(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The legal name under the store name, unless it is the same name again. */
export function legalNameLine(store: Pick<PosReceipt["store"], "name" | "legalName">): string | null {
  const legal = store.legalName?.trim();
  return legal && legal.toLowerCase() !== store.name.trim().toLowerCase() ? legal : null;
}

/** "Ph +91 80 4000 0001" and "WhatsApp +91 90000 00000", whichever are set; printed on one line when they fit. */
export function contactParts(store: Pick<PosReceipt["store"], "phone" | "whatsapp">): string[] {
  return [store.phone && `Ph ${store.phone}`, store.whatsapp && `WhatsApp ${store.whatsapp}`].filter((p): p is string => !!p);
}

/** "1. Cotton Kurta – Blue / M" */
export function lineName(line: Pick<Line, "title" | "variantTitle">, index: number): string {
  return `${index + 1}. ${line.title}${line.variantTitle ? ` – ${line.variantTitle}` : ""}`;
}

/** "HSN 6211 · 1 × 1,299.00" */
export function lineDetail(line: Pick<Line, "hsn" | "quantity" | "unitPrice">): string {
  const quantity = `${line.quantity} × ${rollAmount(line.unitPrice)}`;
  return line.hsn ? `HSN ${line.hsn} · ${quantity}` : quantity;
}

/** The item column's code letters, keyed to the GST summary, show when any line has one. */
export function hasTaxCodes(lines: Array<Pick<Line, "taxCode">>): boolean {
  return lines.some((l) => !!l.taxCode);
}

/** "Items 3 · Qty 4" */
export function itemCount(lines: Array<Pick<Line, "quantity">>): string {
  return `Items ${lines.length} · Qty ${lines.reduce((sum, l) => sum + l.quantity, 0)}`;
}

/** IGST on a sale to another state, else CGST and SGST. */
export function taxHeads(r: Pick<PosReceipt, "invoice" | "totals">): "IGST" | "CGST_SGST" {
  return r.invoice?.gstType === "INTER" || r.totals.igst > 0 ? "IGST" : "CGST_SGST";
}

/** The GST summary's Total row. */
export function gstSummaryTotal(rows: PosReceipt["gstSummary"]): { taxable: number; cgst: number; sgst: number; igst: number } {
  return {
    taxable: round2(rows.reduce((sum, r) => sum + r.taxable, 0)),
    cgst: round2(rows.reduce((sum, r) => sum + r.cgst, 0)),
    sgst: round2(rows.reduce((sum, r) => sum + r.sgst, 0)),
    igst: round2(rows.reduce((sum, r) => sum + r.igst, 0)),
  };
}

/**
 * Place of supply belongs on a business customer's bill and on a sale to
 * another state (Rule 46(n)); a walk-in's bill at the counter does without.
 */
export function showsPlaceOfSupply(r: Pick<PosReceipt, "invoice" | "customer">): boolean {
  return !!r.invoice?.placeOfSupply && (!!r.customer?.gstin || r.invoice.gstType === "INTER");
}

/** "Customer: Priya · +91 98XXXXXX10", with whatever the receipt may show of them. */
export function customerLine(customer: PosReceipt["customer"]): string | null {
  const parts = [customer?.name, customer?.phoneShown].filter(Boolean);
  return parts.length ? `Customer: ${parts.join(" · ")}` : null;
}

/** What the QR is for, printed under it. */
export function qrCaption(qr: NonNullable<PosReceipt["qr"]>): string {
  return qr.kind === "ebill" ? "Scan for your e-bill and returns" : `Scan to pay ₹${rollAmount(qr.amount)}`;
}

/** The footer's line; a bill of supply or a bill is not an invoice, so says "bill". */
export function computerGeneratedNote(title: PosReceipt["document"]["title"]): string {
  return title === "TAX INVOICE" ? "This is a computer-generated invoice." : "This is a computer-generated bill.";
}
