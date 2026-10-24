import { readAddress } from "~/lib/address";
import { formatCurrency } from "~/lib/utils";
import type { InvoiceDetail } from "~/types/api";

/**
 * The invoice as a printed document, rendered in HTML.
 *
 * One layout, three consumers: the invoice page's preview, the print route and
 * (mirrored in PDF primitives by the server, `server/src/invoice/pdf/invoice-pdf.tsx`). It was the body of
 * the print route; it moved here so the page did not become a second copy of
 * 250 lines of statutory layout.
 */
export function InvoiceDocument({ invoice }: { invoice: InvoiceDetail }) {
  const currency = invoice.currency ?? "INR";
  const isCancelled = invoice.status === "CANCELLED";
  const isIntra = invoice.gstType === "CGST_SGST";
  // Money fields arrive as Prisma Decimals, i.e. strings. Coerce before any
  // comparison — "0.00" is truthy and would render an empty discount row.
  const num = (value: number | string | null | undefined) => Number(value ?? 0);
  const discount = num(invoice.totalDiscount);
  // Only the part added on top of the lines. Invoices that taxed shipping into
  // the lines still store the full charge, and printing it here listed it twice.
  const shipping = Math.max(
    0,
    Math.min(
      num(invoice.shippingCharge),
      Math.round(
        (num(invoice.grandTotal) - num(invoice.subtotal) - num(invoice.totalTax)) * 100,
      ) / 100,
    ),
  );
  // Pre-discount value of the goods. Shown so the "less discount" line has
  // something to be subtracted from — `subtotal` is already net of it.
  const grossValue = num(invoice.subtotal) + discount;

  const sellerAddress = readAddress(
    invoice.sellerAddress as Record<string, unknown> | null,
  );
  // "Dispatch from" is shown ONLY when the goods left from somewhere other
  // than the registered address. Printing it when the two are the same would
  // add a line to every invoice that says nothing — and most merchants ship
  // from their principal place of business.
  const dispatchAddress = readAddress(
    invoice.dispatchAddress as Record<string, unknown> | null,
  );
  const buyerAddress = readAddress(
    invoice.buyerAddress as Record<string, unknown> | null,
  );
  const showDispatch =
    !!invoice.dispatchName &&
    dispatchAddress.lines.length > 0 &&
    dispatchAddress.lines.join("|") !== sellerAddress.lines.join("|");

  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-[12px] text-gray-900">
      {/* A cancelled invoice used to print byte-identical to a live one. */}
      {isCancelled && (
        <div className="mb-4 rounded-md border-2 border-red-600 px-4 py-2 text-center">
          <p className="text-base font-bold uppercase tracking-widest text-red-600">
            Cancelled
          </p>
          <p className="text-[11px] text-red-700">
            This invoice was cancelled
            {invoice.cancelledAt
              ? ` on ${new Date(invoice.cancelledAt).toLocaleDateString("en-IN", {
                  day: "2-digit",
                  month: "long",
                  year: "numeric",
                })}`
              : ""}{" "}
            and carries no tax liability.
          </p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between border-b pb-4">
        <div>
          <h1 className="text-xl font-bold">Tax Invoice</h1>
          <p className="text-[11px] text-gray-600">GST-compliant invoice</p>
        </div>
        <div className="text-right">
          <p className="font-semibold">{invoice.invoiceNumber}</p>
          <p className="text-[11px] text-gray-600">
            {new Date(invoice.invoiceDate).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
          </p>
          <p className="text-[11px] text-gray-600">FY {invoice.financialYear}</p>
        </div>
      </div>

      {/* Seller / Buyer. Address is a statutory field on both sides. */}
      <div className="mt-4 grid grid-cols-2 gap-6">
        <Block title="Seller">
          <p className="font-semibold">{invoice.sellerLegalName}</p>
          {sellerAddress.lines.map((line) => (
            <p key={line} className="text-[11px]">
              {line}
            </p>
          ))}
          <p className="text-[11px]">
            {invoice.sellerStateCode} — {invoice.sellerStateName}
          </p>
          <p className="text-[11px]">GSTIN: {invoice.sellerGstin}</p>
        </Block>
        <Block title="Buyer">
          <p className="font-semibold">{invoice.buyerName}</p>
          {buyerAddress.lines.map((line) => (
            <p key={line} className="text-[11px]">
              {line}
            </p>
          ))}
          <p className="text-[11px]">
            {invoice.buyerStateCode} — {invoice.buyerStateName}
          </p>
          {invoice.buyerGstin ? (
            <p className="text-[11px]">GSTIN: {invoice.buyerGstin}</p>
          ) : (
            <p className="text-[11px] italic text-gray-600">Unregistered (B2C)</p>
          )}
        </Block>
      </div>

      {showDispatch && (
        <div className="mt-3">
          <Block title="Dispatch from">
            <p className="font-semibold">{invoice.dispatchName}</p>
            {dispatchAddress.lines.map((line) => (
              <p key={line} className="text-[11px]">
                {line}
              </p>
            ))}
          </Block>
        </div>
      )}

      {/* Place of supply */}
      <div className="mt-3 rounded-md border bg-gray-50 px-3 py-2 text-[11px]">
        <span className="text-gray-600">Place of supply: </span>
        <span className="font-medium">
          {invoice.placeOfSupply} — {invoice.placeOfSupplyName}
        </span>
        <span className="ml-3 text-gray-600">Type: </span>
        <span className="font-medium">
          {isIntra ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"}
        </span>
        {/* Rule 46(p) requires a tax invoice to state whether tax is payable
            on reverse charge. It belongs here rather than in the totals
            ladder below, which is arithmetic only — this is a declaration,
            not an addend. */}
        <span className="ml-3 text-gray-600">Reverse charge: </span>
        <span className="font-medium">{invoice.reverseCharge ? "Yes" : "No"}</span>
      </div>

      {/* Line items */}
      <table className="mt-4 w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b bg-gray-50 text-left">
            <th className="px-2 py-1.5 font-medium">Description</th>
            <th className="px-2 py-1.5 font-medium">HSN</th>
            <th className="px-2 py-1.5 text-right font-medium">Qty</th>
            <th className="px-2 py-1.5 text-right font-medium">Unit</th>
            <th className="px-2 py-1.5 text-right font-medium">Disc.</th>
            <th className="px-2 py-1.5 text-right font-medium">Taxable</th>
            {isIntra ? (
              <>
                <th className="px-2 py-1.5 text-right font-medium">CGST</th>
                <th className="px-2 py-1.5 text-right font-medium">SGST</th>
              </>
            ) : (
              <th className="px-2 py-1.5 text-right font-medium">IGST</th>
            )}
            <th className="px-2 py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((li) => (
            <tr key={li.id} className="border-b last:border-b-0">
              <td className="px-2 py-1.5">{li.description}</td>
              <td className="px-2 py-1.5">{li.hsnCode}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{li.quantity}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {formatCurrency(li.unitPrice, currency)}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {num(li.discount) > 0 ? `−${formatCurrency(li.discount, currency)}` : "—"}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {formatCurrency(li.taxableValue, currency)}
              </td>
              {isIntra ? (
                <>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCurrency(li.cgstAmount, currency)} ({li.cgstRate}%)
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCurrency(li.sgstAmount, currency)} ({li.sgstRate}%)
                  </td>
                </>
              ) : (
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {formatCurrency(li.igstAmount, currency)} ({li.igstRate}%)
                </td>
              )}
              <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                {formatCurrency(li.totalAmount, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals ladder that reconciles to the grand total:
          gross → less discount → taxable → tax → shipping → grand total. */}
      <div className="mt-4 ml-auto w-80 space-y-1 text-[11px]">
        {discount > 0 && (
          <>
            <Row label="Gross value" value={formatCurrency(grossValue, currency)} />
            <Row
              label="Less: discount"
              value={`−${formatCurrency(invoice.totalDiscount, currency)}`}
            />
          </>
        )}
        <Row label="Taxable value" value={formatCurrency(invoice.subtotal, currency)} />
        {isIntra ? (
          <>
            <Row label="CGST" value={formatCurrency(invoice.totalCgst, currency)} />
            <Row label="SGST" value={formatCurrency(invoice.totalSgst, currency)} />
          </>
        ) : (
          <Row label="IGST" value={formatCurrency(invoice.totalIgst, currency)} />
        )}
        {shipping > 0 && (
          <Row
            label="Shipping (not taxed)"
            value={formatCurrency(shipping, currency)}
          />
        )}
        <div className="border-t pt-1">
          <Row label="Grand total" value={formatCurrency(invoice.grandTotal, currency)} bold />
        </div>
      </div>

      {invoice.notes && (
        <div className="mt-4 border-t pt-3 text-[11px] text-gray-700">
          <span className="font-medium">Notes: </span>
          {invoice.notes}
        </div>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div
      className={`flex justify-between ${
        bold ? "font-semibold text-gray-900" : "text-gray-700"
      }`}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
