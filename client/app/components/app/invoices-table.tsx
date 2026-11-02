import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Ban,
  Copy,
  Eye,
  FileDown,
  Loader2,
  MoreHorizontal,
  Printer,
  ShoppingBag,
} from "lucide-react";
import { toast } from "sonner";
import { downloadInvoicePdf } from "~/lib/invoice-pdf";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "~/components/ui/dropdown-menu";
import {
  DateCell,
  MoneyCell,
  PersonCell,
  StatusPill,
  type ColumnDef,
} from "~/components/app/data-table";
import { cn } from "~/lib/utils";
import {
  GST_TYPE_LABELS,
  INVOICE_STATUS_CLASSES,
  INVOICE_STATUS_DOTS,
  INVOICE_STATUS_LABELS,
  effectiveGstRate,
  resolveDisplayStatus,
} from "~/lib/invoice-status";
import type { Invoice } from "~/types/api";

/**
 * Column definitions for the invoices list. Sorting is server-side (`sortBy`
 * / `sortOrder` on the list DTO, whitelisted there to the `sortKey`s below),
 * so the table only reports the intent upwards — it never reorders the
 * page-sized slice it is holding.
 */
export function useInvoiceColumns(currency: string): ColumnDef<Invoice>[] {
  return useMemo(
    () => [
      {
        key: "invoice",
        label: "Invoice",
        width: 190,
        locked: true,
        sortKey: "invoiceNumber",
        sortType: "text",
        cell: (invoice) => {
          const displayStatus = resolveDisplayStatus(invoice);
          const rate = effectiveGstRate(invoice);
          return (
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", INVOICE_STATUS_DOTS[displayStatus])}
              />
              <div className="flex min-w-0 flex-col leading-[1.3]">
                <span className="truncate font-mono font-semibold text-foreground">
                  {invoice.invoiceNumber}
                </span>
                <span className="truncate text-caption text-muted-foreground">
                  {GST_TYPE_LABELS[invoice.gstType]}
                  {rate !== null && ` · ${rate}%`}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        key: "buyer",
        label: "Buyer",
        width: 240,
        sortKey: "buyerName",
        sortType: "text",
        cell: (invoice) => (
          <PersonCell
            name={invoice.buyerName}
            sub={
              invoice.buyerGstin ? (
                <span className="font-mono">{invoice.buyerGstin}</span>
              ) : (
                "B2C · unregistered"
              )
            }
            title={`${invoice.buyerName}\n${invoice.buyerGstin ?? "B2C · unregistered"}`}
          />
        ),
      },
      {
        key: "date",
        label: "Date",
        width: 120,
        sortKey: "invoiceDate",
        sortType: "date",
        cell: (invoice) => <DateCell value={invoice.invoiceDate} />,
      },
      {
        key: "status",
        label: "Status",
        width: 110,
        cell: (invoice) => {
          const displayStatus = resolveDisplayStatus(invoice);
          return (
            <StatusPill className={INVOICE_STATUS_CLASSES[displayStatus]}>
              {INVOICE_STATUS_LABELS[displayStatus]}
            </StatusPill>
          );
        },
      },
      {
        key: "taxable",
        label: "Taxable",
        width: 120,
        align: "right",
        sortKey: "subtotal",
        sortType: "number",
        cell: (invoice) => (
          <MoneyCell amount={invoice.subtotal} currency={invoice.currency || currency} />
        ),
      },
      {
        key: "tax",
        label: "Tax",
        width: 110,
        align: "right",
        sortKey: "totalTax",
        sortType: "number",
        cell: (invoice) => (
          <MoneyCell amount={invoice.totalTax} currency={invoice.currency || currency} muted />
        ),
      },
      {
        key: "total",
        label: "Total",
        width: 130,
        align: "right",
        sortKey: "grandTotal",
        sortType: "number",
        cell: (invoice) => (
          <MoneyCell amount={invoice.grandTotal} currency={invoice.currency || currency} strong />
        ),
      },
      {
        // Links through to the order the invoice was raised against. A link
        // inside a cell never triggers the row click.
        key: "order",
        label: "Order",
        width: 100,
        cell: (invoice) => (
          <Link
            to={`/orders/${invoice.order.id}`}
            className="truncate text-muted-foreground underline-offset-3 hover:text-foreground hover:underline"
          >
            {invoice.order.name}
          </Link>
        ),
      },
    ],
    [currency],
  );
}

/** An invoice as a three-line phone card: number and total, buyer and date, then status and tax. */
export function InvoiceMobileSummary({ invoice, currency }: { invoice: Invoice; currency: string }) {
  const displayStatus = resolveDisplayStatus(invoice);
  const rate = effectiveGstRate(invoice);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <p className="min-w-0 truncate font-mono font-semibold text-foreground">{invoice.invoiceNumber}</p>
        <MoneyCell amount={invoice.grandTotal} currency={invoice.currency || currency} strong />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
        <span className="min-w-0 truncate">{invoice.buyerName}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0"><DateCell value={invoice.invoiceDate} /></span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-caption text-muted-foreground">
        <StatusPill className={INVOICE_STATUS_CLASSES[displayStatus]}>
          {INVOICE_STATUS_LABELS[displayStatus]}
        </StatusPill>
        <span>
          {invoice.buyerGstin ? "B2B" : "B2C"} · {GST_TYPE_LABELS[invoice.gstType]}
          {rate !== null && ` · ${rate}%`}
        </span>
      </div>
    </div>
  );
}

/**
 * One menu per row: view and navigate, then documents, then the destructive
 * one. Owns its own download flag so a second click while the PDF engine is
 * still loading cannot produce two downloads of the same file.
 */
export function InvoiceRowActions({
  invoice,
  canCancel,
  onSelect,
  onCancel,
}: {
  invoice: Invoice;
  /** Cancelling is ORG_MANAGERS-only server-side — see `useInvoiceActionGates`. */
  canCancel: boolean;
  onSelect: (id: string) => void;
  /** Opens the cancel confirmation — never cancels directly. */
  onCancel: (invoice: Invoice) => void;
}) {
  const [downloading, setDownloading] = useState(false);

  async function downloadPdf() {
    setDownloading(true);
    try {
      await downloadInvoicePdf({ id: invoice.id, invoiceNumber: invoice.invoiceNumber });
    } finally {
      setDownloading(false);
    }
  }

  async function copyInvoiceNumber() {
    try {
      await navigator.clipboard.writeText(invoice.invoiceNumber);
      toast.success(`Copied ${invoice.invoiceNumber}`);
    } catch {
      // Clipboard access is denied outside secure contexts and under some
      // policies. Say so, rather than reporting a copy that did not happen.
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for invoice ${invoice.invoiceNumber}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* Wide enough that "Copy invoice no." and the order suffix never wrap —
          a two-line menu item reads as two items. */}
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => onSelect(invoice.id)}>
          <Eye />
          View details
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={`/orders/${invoice.order.id}`}>
            <ShoppingBag />
            Open order
            <DropdownMenuShortcut>{invoice.order.name}</DropdownMenuShortcut>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem disabled={downloading} onSelect={downloadPdf}>
          {downloading ? <Loader2 className="animate-spin" /> : <FileDown />}
          Download PDF
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          {/* New tab, matching how order detail opens this same route —
              printing shouldn't lose the list you were on. */}
          <Link to={`/orders/invoices/${invoice.id}/print`} target="_blank" rel="noreferrer">
            <Printer />
            Print
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={copyInvoiceNumber}>
          <Copy />
          Copy invoice no.
        </DropdownMenuItem>

        {/* Cancelling is ORG_MANAGERS-only server-side; without the role check
            this item could only ever 403. */}
        {canCancel && invoice.status === "ISSUED" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onCancel(invoice)}>
              <Ban />
              Cancel invoice
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
