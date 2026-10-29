import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { invoiceService } from "~/services/invoice.service";
import type { InvoiceListParams, GstReturnParams } from "~/types/api";

/** React Query key factory for all invoice-related queries. */
export const invoiceKeys = {
  all: ["invoices"] as const,
  list: (params?: InvoiceListParams) =>
    [...invoiceKeys.all, "list", params] as const,
  detail: (id: string) =>
    [...invoiceKeys.all, "detail", id] as const,
  pdf: (id: string) =>
    [...invoiceKeys.all, "pdf", id] as const,
  stats: (params?: { financialYear?: string }) =>
    [...invoiceKeys.all, "stats", params] as const,
  gstReturn: (params: GstReturnParams) =>
    [...invoiceKeys.all, "gst-return", params] as const,
  filings: (financialYear?: string) =>
    [...invoiceKeys.all, "filings", financialYear] as const,
};

/** Fetch a paginated list of invoices with optional filters. */
export function useInvoices(params?: InvoiceListParams) {
  return useQuery({
    queryKey: invoiceKeys.list(params),
    queryFn: () => invoiceService.list(params),
    // The previous page stays on screen, dimmed, while the next one loads.
    placeholderData: keepPreviousData,
  });
}

/** Fetch a single invoice by ID. */
export function useInvoice(id?: string | null) {
  return useQuery({
    queryKey: invoiceKeys.detail(id!),
    queryFn: () => invoiceService.get(id!),
    enabled: !!id,
  });
}

/**
 * The invoice as the PDF customers are sent, for drawing on screen and
 * printing. Under `invoiceKeys.all`, so an edit or a cancellation redraws it.
 */
export function useInvoicePdf(id?: string | null) {
  return useQuery({
    queryKey: invoiceKeys.pdf(id!),
    queryFn: () => invoiceService.pdf(id!).then((blob) => blob.arrayBuffer()),
    enabled: !!id,
    // Each refetch redraws every page; nothing about the file changes on focus.
    refetchOnWindowFocus: false,
  });
}

/** Fetch GST return summary (GSTR-1 or GSTR-3B). */
export function useGstReturn(params: GstReturnParams | null) {
  return useQuery({
    queryKey: invoiceKeys.gstReturn(params!),
    queryFn: () => invoiceService.getGstReturn(params!),
    enabled: !!params?.financialYear && !!params?.period,
  });
}

/**
 * Which periods have been filed, and are therefore locked.
 *
 * Nested under `invoiceKeys.all`, so the mark-filed and reopen mutations
 * already invalidate it along with everything else the lock affects.
 */
export function useGstFilings(financialYear?: string) {
  return useQuery({
    queryKey: invoiceKeys.filings(financialYear),
    queryFn: () => invoiceService.listFilings(financialYear),
  });
}

/** Aggregates for the KPI row and the filter-chip counts. */
export function useInvoiceStats(params?: { financialYear?: string }) {
  return useQuery({
    queryKey: invoiceKeys.stats(params),
    queryFn: () => invoiceService.stats(params),
  });
}

/**
 * Refunded orders whose invoice has not been credited.
 *
 * Only fetched when the stats count says there is something to fetch — the
 * banner drives this, not the other way round, so a healthy org pays nothing.
 */
export function useRefundsPendingCredit(enabled: boolean) {
  return useQuery({
    queryKey: [...invoiceKeys.all, "refunds-pending-credit"] as const,
    queryFn: () => invoiceService.listRefundsPendingCredit(),
    enabled,
  });
}
