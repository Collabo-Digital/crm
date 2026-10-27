import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { PdfPages } from "~/components/app/pdf-pages";
import { useInvoice, useInvoicePdf } from "~/hooks/use-invoice-queries";
import { documentLabel } from "~/lib/invoice-status";

export function meta() {
  return [{ title: "Print invoice | Collabo CRM" }];
}

/**
 * Printable invoice: the server's PDF, each page drawn at 300 dpi into an
 * image of its paper size, then the print dialog. Printing the drawn pages
 * rather than the PDF file works the same in every browser, phones included,
 * none of which can print a PDF inside a page.
 */
export default function InvoicePrintPage() {
  const { id } = useParams<{ id: string }>();
  const invoice = useInvoice(id);
  const pdf = useInvoicePdf(id);
  const [ready, setReady] = useState(false);
  const [drawFailed, setDrawFailed] = useState(false);
  const isCancelled = invoice.data?.status === "CANCELLED";
  const label = invoice.data ? `${documentLabel(invoice.data)} ${invoice.data.invoiceNumber}` : "Invoice";

  useEffect(() => {
    if (invoice.data) document.title = `${label} | Collabo CRM`;
  }, [invoice.data, label]);

  // Print once per invoice, not once per response: a refetch that redraws
  // the pages must not throw a second print dialog at someone mid-review.
  //
  // Cancelled invoices are excluded: auto-printing one puts a void document in
  // someone's hand with no deliberate action. The button below still works if
  // a printed copy is genuinely wanted — it carries the CANCELLED mark.
  const printedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !invoice.data || isCancelled || printedRef.current === invoice.data.id) return;
    printedRef.current = invoice.data.id;
    window.print();
  }, [ready, invoice.data, isCancelled]);

  // Error must be checked before the loading state: a failed request leaves
  // the data undefined, which would otherwise read as "still loading" forever.
  if (invoice.isError || pdf.isError || drawFailed) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium text-foreground">Couldn't load this invoice.</p>
        <p className="text-xs text-muted-foreground">
          It may have been removed, or the request failed on the way.
        </p>
        <button
          onClick={() => {
            setDrawFailed(false);
            void invoice.refetch();
            void pdf.refetch();
          }}
          className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-medium text-white hover:bg-gray-800"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-200 py-6 print:bg-white print:py-0">
      <style>{`
        @page { size: A4; margin: 0; }
        @media print {
          html, body { background: #fff !important; margin: 0; }
          .no-print { display: none !important; }
          .pdf-print-page { box-shadow: none !important; margin: 0 !important; break-after: page; }
          .pdf-print-page:last-child { break-after: auto; }
        }
        @media screen {
          .pdf-print-page { margin: 0 auto 16px; max-width: calc(100vw - 32px); height: auto !important; box-shadow: 0 1px 4px rgb(0 0 0 / 0.2); }
        }
      `}</style>

      <div className="no-print mx-auto mb-4 flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 text-xs">
        <p className="text-neutral-700">
          {ready ? label : invoice.data ? `Preparing ${label} for printing…` : "Loading invoice…"}
        </p>
        <button
          onClick={() => window.print()}
          disabled={!ready}
          className="rounded-lg bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          Print
        </button>
      </div>

      <PdfPages
        data={pdf.data}
        label={label}
        mode="print"
        onRendered={() => setReady(true)}
        onError={() => setDrawFailed(true)}
      />
    </div>
  );
}
