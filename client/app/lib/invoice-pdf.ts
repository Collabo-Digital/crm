import { downloadBlob } from "~/lib/download-blob";
import { invoiceService } from "~/services/invoice.service";
import type { InvoiceDetail } from "~/types/api";

/**
 * Save an invoice as a PDF file.
 *
 * The server renders it, so the file downloaded here is the same document
 * customers are sent on WhatsApp.
 *
 * Accepts an id (list rows carry no line items) or a loaded detail (page,
 * print route).
 */
export async function downloadInvoicePdf(
  invoiceOrId: Pick<InvoiceDetail, "id" | "invoiceNumber"> | string,
): Promise<void> {
  const id = typeof invoiceOrId === "string" ? invoiceOrId : invoiceOrId.id;
  const name = typeof invoiceOrId === "string" ? "invoice" : invoiceOrId.invoiceNumber;
  await downloadBlob(() => invoiceService.pdf(id), invoicePdfFilename(name), "Couldn't download the invoice PDF.");
}

/** `INV-26-27/000036` → `INV-26-27-000036.pdf`; a slash is a path separator. */
export function invoicePdfFilename(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
}
