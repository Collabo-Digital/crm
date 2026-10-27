import type { FinancialStatus, GstType, Invoice, InvoiceStatus } from "~/types/api";

/**
 * Canonical invoice-status pill styling, labels and derived display state.
 *
 * Same shape as `order-status.ts` and `customer-status.ts`, for the same reason:
 * these maps were inlined in `routes/app/orders/invoices.tsx` on raw palette
 * utilities (`bg-green-50 text-green-700 dark:bg-green-900/20`) with no token
 * behind them, so the list and the detail dialog could drift apart.
 */

/**
 * What the status column actually shows.
 *
 * `UNPAID` is not a stored status. The design shows it *in place of* `Issued`
 * when the invoice's order still owes money, so the displayed value is a
 * composite of two fields. It lives in its own type rather than in
 * `InvoiceStatus`, which mirrors the Prisma enum and must not grow a member the
 * database cannot store.
 */
export type InvoiceDisplayStatus = InvoiceStatus | "UNPAID";

export const INVOICE_STATUS_CLASSES: Record<InvoiceDisplayStatus, string> = {
  ISSUED: "bg-brand/30 text-brand-strong",
  UNPAID: "bg-warning-strong-subtle text-warning-strong",
  DRAFT: "bg-muted text-muted-foreground",
  CANCELLED: "bg-danger-subtle text-danger",
  CREDIT_NOTE: "bg-info-subtle text-info",
};

export const INVOICE_STATUS_LABELS: Record<InvoiceDisplayStatus, string> = {
  ISSUED: "Issued",
  UNPAID: "Unpaid",
  DRAFT: "Draft",
  CANCELLED: "Cancelled",
  CREDIT_NOTE: "Credit note",
};

/**
 * Order payment states that leave money outstanding. `REFUNDED` and `VOIDED`
 * are deliberately absent — nothing is owed on either, so neither should read
 * as "Unpaid".
 */
const OUTSTANDING_FINANCIAL_STATES: ReadonlySet<FinancialStatus> = new Set([
  "PENDING",
  "AUTHORIZED",
  "PARTIALLY_PAID",
]);

/** Resolve the pill to show for one row. Only ISSUED invoices can read UNPAID. */
export function resolveDisplayStatus(invoice: {
  status: InvoiceStatus;
  order?: { financialStatus?: FinancialStatus | null } | null;
}): InvoiceDisplayStatus {
  if (invoice.status !== "ISSUED") return invoice.status;

  const financialStatus = invoice.order?.financialStatus;
  return financialStatus && OUTSTANDING_FINANCIAL_STATES.has(financialStatus)
    ? "UNPAID"
    : "ISSUED";
}

/**
 * What the document is: a credit note, or what it was issued as. A cancelled
 * document keeps its kind, and one issued before the snapshot existed was a
 * tax invoice.
 */
export function documentLabel(
  invoice: Pick<Invoice, "status" | "metadata">,
): "Tax invoice" | "Bill of supply" | "Credit note" {
  if (invoice.status === "CREDIT_NOTE") return "Credit note";
  return invoice.metadata?.render?.documentType === "BILL_OF_SUPPLY" ? "Bill of supply" : "Tax invoice";
}

/** Short labels for the row sub-label — the column is narrow. */
export const GST_TYPE_LABELS: Record<GstType, string> = {
  CGST_SGST: "Intra",
  IGST: "Inter",
};

/**
 * Blended GST rate for the row sub-label ("Intra · 18%").
 *
 * The list payload carries no line items, so this is the *effective* rate across
 * the whole invoice: one mixing 5% and 18% lines shows a single blended figure
 * rather than either rate. Returns null when there is no taxable base to divide
 * by, so the caller drops the suffix instead of rendering "NaN%".
 */
export function effectiveGstRate(invoice: {
  subtotal: number;
  totalTax: number;
}): number | null {
  // Coerced, not truthiness-checked. Prisma `Decimal` columns serialise to
  // JSON as STRINGS, so a zero subtotal arrives as "0.00" — which is truthy.
  // The guard passed, the division ran as 0/0, and the row sub-label rendered
  // "NaN%". The division itself worked by string coercion, which is exactly why
  // this went unnoticed for every non-zero invoice.
  const subtotal = Number(invoice.subtotal);
  const totalTax = Number(invoice.totalTax);
  if (!Number.isFinite(subtotal) || subtotal === 0) return null;
  return Math.round((totalTax / subtotal) * 100);
}

/** Leading row dot. Same semantics as the pill, just the fill on its own. */
export const INVOICE_STATUS_DOTS: Record<InvoiceDisplayStatus, string> = {
  ISSUED: "bg-brand",
  UNPAID: "bg-warning-strong",
  DRAFT: "bg-muted-foreground/40",
  CANCELLED: "bg-danger",
  CREDIT_NOTE: "bg-info",
};
