import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  Ban,
  ChevronRight,
  FileDown,
  Loader2,
  Pencil,
  Printer,
  ShoppingBag,
  Undo2,
  X,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import { QueryErrorState } from "~/components/app/query-error-state";
import { PdfPages } from "~/components/app/pdf-pages";
import { CancelInvoiceDialog } from "~/components/app/cancel-invoice-dialog";
import { CreditNoteDialog } from "~/components/app/credit-note-dialog";
import { useInvoice, useInvoicePdf } from "~/hooks/use-invoice-queries";
import { useUpdateInvoiceMutation } from "~/hooks/use-invoice-mutations";
import { useInvoiceActionGates } from "~/hooks/use-invoice-action-gates";
import { isString, useSessionState } from "~/hooks/use-session-state";
import { downloadInvoicePdf } from "~/lib/invoice-pdf";
import {
  INVOICE_STATUS_CLASSES,
  INVOICE_STATUS_LABELS,
  documentLabel,
  resolveDisplayStatus,
} from "~/lib/invoice-status";
import { cn } from "~/lib/utils";
import type { InvoiceDetail, UpdateInvoiceRequest } from "~/types/api";
import { pageTitle } from "~/lib/page-title";

export function meta() {
  return [{ title: "Invoice | Collabo CRM" }];
}

/** Mirrors `GSTIN_REGEX` on the server; the server is still the authority. */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * The editable subset of an invoice, as form state.
 *
 * Only the buyer block and the notes: amounts, lines, dates, number and place
 * of supply are fixed once a GST invoice is issued. The server enforces this
 * (its DTO cannot carry them); the form simply never offers them.
 */
type Draft = {
  buyerName: string;
  buyerGstin: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  country: string;
  notes: string;
};

/** The stored JSON uses either Shopify's snake_case or our camelCase keys. */
function pick(address: Record<string, unknown> | null, ...keys: string[]): string {
  for (const key of keys) {
    const value = address?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function draftFrom(invoice: InvoiceDetail): Draft {
  const a = invoice.buyerAddress;
  return {
    buyerName: invoice.buyerName,
    buyerGstin: invoice.buyerGstin ?? "",
    address1: pick(a, "address1", "address_1"),
    address2: pick(a, "address2", "address_2"),
    city: pick(a, "city"),
    province: pick(a, "province", "state"),
    zip: pick(a, "zip", "postal_code", "pincode"),
    country: pick(a, "country"),
    notes: invoice.notes ?? "",
  };
}

function toRequest(d: Draft): UpdateInvoiceRequest {
  return {
    buyerName: d.buyerName.trim(),
    buyerGstin: d.buyerGstin.trim() || null,
    buyerAddress: {
      address1: d.address1.trim(),
      address2: d.address2.trim(),
      city: d.city.trim(),
      province: d.province.trim(),
      zip: d.zip.trim(),
      country: d.country.trim(),
    },
    notes: d.notes.trim() || null,
  };
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { data: invoice, isLoading, isError, refetch } = useInvoice(id);
  const { canCancel } = useInvoiceActionGates();
  const pdf = useInvoicePdf(id);
  const [pdfFailed, setPdfFailed] = useState(false);
  // The list mirrors its filters to the session; go back to the same view.
  const [savedListParams] = useSessionState("invoices.params", "", isString);
  const listPath = `/orders/invoices${savedListParams ? `?${savedListParams}` : ""}`;
  const updateInvoice = useUpdateInvoiceMutation();

  const [draft, setDraft] = useState<Draft | null>(null); // non-null = editing
  const [downloading, setDownloading] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<{
    id: string;
    invoiceNumber: string;
  } | null>(null);
  const [creditTarget, setCreditTarget] = useState<InvoiceDetail | null>(null);

  if (isError) {
    return <QueryErrorState resource="this invoice" onRetry={() => refetch()} />;
  }
  if (isLoading || !invoice) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[640px] w-full" />
      </div>
    );
  }

  const current = invoice;
  const editing = draft !== null;
  const label = documentLabel(current);
  const displayStatus = resolveDisplayStatus(current);
  const gstinInvalid =
    !!draft && draft.buyerGstin !== "" && !GSTIN_PATTERN.test(draft.buyerGstin);
  const nameMissing = !!draft && !draft.buyerName.trim();
  const canEdit = canCancel && current.status === "ISSUED";

  async function downloadPdf() {
    setDownloading(true);
    try {
      await downloadInvoicePdf(current);
    } finally {
      setDownloading(false);
    }
  }

  function save() {
    if (!draft || gstinInvalid || nameMissing) return;
    updateInvoice.mutate(
      { id: current.id, data: toRequest(draft) },
      { onSuccess: () => setDraft(null) },
    );
  }

  const field = (key: keyof Draft) => ({
    value: draft?.[key] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft((d) => (d ? { ...d, [key]: e.target.value } : d)),
  });

  return (
    <div className="space-y-4">
      <title>{pageTitle(`${label} ${current.invoiceNumber}`)}</title>
      {/* The number shows in the breadcrumb; this is the page's heading. */}
      <h1 className="sr-only">
        {label} {current.invoiceNumber}
      </h1>
      {/* Breadcrumb + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-caption">
          {/* On a phone the app bar's back arrow replaces the link. */}
          <Link to={listPath} className="text-muted-foreground hover:text-foreground max-md:hidden">
            Invoices
          </Link>
          <ChevronRight className="size-3 text-muted-foreground max-md:hidden" />
          <span className="font-medium text-foreground">{current.invoiceNumber}</span>
          {/* A credit note's pill already says so. */}
          {label !== INVOICE_STATUS_LABELS[displayStatus] && <span className="text-muted-foreground">· {label}</span>}
          <span
            className={cn(
              "ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium",
              INVOICE_STATUS_CLASSES[displayStatus],
            )}
          >
            {INVOICE_STATUS_LABELS[displayStatus]}
          </span>
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDraft(null)}
                disabled={updateInvoice.isPending}
              >
                <X />
                Discard
              </Button>
              <Button
                variant="brand"
                size="sm"
                onClick={save}
                disabled={updateInvoice.isPending || gstinInvalid || nameMissing}
              >
                {updateInvoice.isPending ? <Loader2 className="animate-spin" /> : null}
                Save changes
              </Button>
            </>
          ) : (
            <>
              {canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDraft(draftFrom(current))}
                >
                  <Pencil />
                  Edit
                </Button>
              )}
              <Button variant="outline" size="sm" asChild>
                <Link
                  to={`/orders/invoices/${current.id}/print`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Printer />
                  Print
                </Link>
              </Button>
              <Button variant="brand" size="sm" onClick={downloadPdf} disabled={downloading}>
                {downloading ? <Loader2 className="animate-spin" /> : <FileDown />}
                Download PDF
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Left rail: the edit form, or the order link and secondary actions */}
        <aside className="w-full shrink-0 space-y-3 rounded-xl bg-card p-4 lg:sticky lg:top-6 lg:w-80 lg:self-start">
          {draft ? (
            <>
              <p className="text-micro uppercase tracking-wider text-muted-foreground">
                Buyer
              </p>
              <div>
                <Input
                  placeholder="Buyer name"
                  aria-label="Buyer name"
                  aria-invalid={nameMissing}
                  aria-describedby={nameMissing ? "invoice-buyer-name-error" : undefined}
                  {...field("buyerName")}
                />
                {nameMissing && (
                  <p id="invoice-buyer-name-error" className="mt-1 text-micro text-danger">Buyer name is required.</p>
                )}
              </div>
              <div>
                <Input
                  placeholder="GSTIN (leave empty for B2C)"
                  aria-label="Buyer GSTIN"
                  maxLength={15}
                  className="font-mono"
                  aria-invalid={gstinInvalid}
                  aria-describedby={gstinInvalid ? "invoice-buyer-gstin-error" : undefined}
                  value={draft.buyerGstin}
                  onChange={(e) =>
                    setDraft((d) =>
                      d ? { ...d, buyerGstin: e.target.value.toUpperCase() } : d,
                    )
                  }
                />
                {gstinInvalid && (
                  <p id="invoice-buyer-gstin-error" className="mt-1 text-micro text-danger">
                    That isn't a valid 15-character GSTIN.
                  </p>
                )}
              </div>

              <p className="pt-1 text-micro uppercase tracking-wider text-muted-foreground">
                Address
              </p>
              <Input placeholder="Address line 1" aria-label="Address line 1" {...field("address1")} />
              <Input placeholder="Address line 2" aria-label="Address line 2" {...field("address2")} />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="City" aria-label="City" {...field("city")} />
                <Input placeholder="PIN code" aria-label="PIN code" {...field("zip")} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="State" aria-label="State" {...field("province")} />
                <Input placeholder="Country" aria-label="Country" {...field("country")} />
              </div>

              <p className="pt-1 text-micro uppercase tracking-wider text-muted-foreground">
                Notes
              </p>
              <Textarea
                rows={3}
                placeholder="Printed on the invoice"
                aria-label="Notes"
                {...field("notes")}
              />
              <p className="text-micro text-muted-foreground">
                Amounts, line items, dates and the invoice number cannot be changed on
                an issued invoice. Raise a credit note or cancel and reissue instead.
              </p>
            </>
          ) : (
            <>
              <div>
                <p className="text-micro uppercase tracking-wider text-muted-foreground">
                  Order
                </p>
                <Button variant="ghost" size="sm" className="-ml-2 mt-1" asChild>
                  <Link to={`/orders/${current.order.id}`}>
                    <ShoppingBag />
                    {current.order.name}
                  </Link>
                </Button>
              </div>
              {canCancel && current.status === "ISSUED" && (
                <div className="space-y-2 border-t pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setCreditTarget(current)}
                    title="Reverses this invoice without deleting it — the correction to use once a period is filed"
                  >
                    <Undo2 />
                    Credit note
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-danger"
                    onClick={() =>
                      setCancelTarget({
                        id: current.id,
                        invoiceNumber: current.invoiceNumber,
                      })
                    }
                  >
                    <Ban />
                    Cancel invoice
                  </Button>
                </div>
              )}
            </>
          )}
        </aside>

        {/* The PDF customers are sent, as the server renders it. */}
        <section className="min-w-0 flex-1 space-y-3">
          {editing && (
            <p className="rounded-lg bg-muted px-3 py-2 text-caption text-muted-foreground">
              This is the saved {label.toLowerCase()}. It changes when you save.
            </p>
          )}
          {pdf.isError || pdfFailed ? (
            <div className="rounded-xl bg-card ring-1 ring-border">
              <QueryErrorState
                resource={`this ${label.toLowerCase()}'s PDF`}
                onRetry={() => {
                  setPdfFailed(false);
                  void pdf.refetch();
                }}
              />
            </div>
          ) : (
            <PdfPages
              data={pdf.data}
              label={`${label} ${current.invoiceNumber}`}
              onRendered={() => setPdfFailed(false)}
              onError={() => setPdfFailed(true)}
              className="mx-auto max-w-3xl"
            />
          )}
        </section>
      </div>

      <CreditNoteDialog
        invoice={creditTarget}
        currency={current.currency}
        onClose={() => setCreditTarget(null)}
      />
      <CancelInvoiceDialog invoice={cancelTarget} onClose={() => setCancelTarget(null)} />
    </div>
  );
}
