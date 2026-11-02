import { apiClient } from "~/lib/api-client";
import type {
  RefundPendingCredit,
  CreateCreditNoteRequest,
  GstFiling,
  MarkFiledRequest,
  PaginatedResponse,
  Invoice,
  InvoiceDetail,
  CreateInvoiceRequest,
  BulkInvoiceResult,
  UpdateInvoiceRequest,
  InvoiceListParams,
  InvoiceStats,
  GstReturnParams,
  GstReturnGstr1,
  GstReturnGstr3B,
} from "~/types/api";

/**
 * Service layer for invoice and GST return endpoints.
 */
export const invoiceService = {
  /** POST /invoices/:id/credit-note — reverse an issued invoice. */
  createCreditNote: (id: string, data: CreateCreditNoteRequest) =>
    apiClient
      .post<InvoiceDetail>(`/invoices/${id}/credit-note`, data)
      .then((res) => res.data),

  /** GET /invoices/refunds-pending-credit — refunded orders not yet credited. */
  listRefundsPendingCredit: () =>
    apiClient
      .get<RefundPendingCredit[]>("/invoices/refunds-pending-credit")
      .then((res) => res.data),

  /** GET /invoices/gst-return/filings — which periods are locked. */
  listFilings: (financialYear?: string) =>
    apiClient
      .get<GstFiling[]>("/invoices/gst-return/filings", {
        params: financialYear ? { financialYear } : undefined,
      })
      .then((res) => res.data),

  /** POST /invoices/gst-return/filings — record a filing, locking the period. */
  markFiled: (data: MarkFiledRequest) =>
    apiClient
      .post<GstFiling>("/invoices/gst-return/filings", data)
      .then((res) => res.data),

  /** DELETE /invoices/gst-return/filings/:id — reopen a period filed in error. */
  unfile: (id: string) =>
    apiClient
      .delete<{ id: string }>(`/invoices/gst-return/filings/${id}`)
      .then((res) => res.data),

  /** Generate a GST invoice for an order. */
  create: (data: CreateInvoiceRequest) =>
    apiClient
      .post<InvoiceDetail>("/invoices", data)
      .then((res) => res.data),

  /**
   * Issue invoices for several orders; ineligible ones come back skipped.
   * The server issues them one at a time, so this outlives the default 30s
   * timeout — a client that gave up early would report a failure for a batch
   * that was still being issued.
   */
  bulkCreate: (orderIds: string[]) =>
    apiClient
      .post<BulkInvoiceResult>("/invoices/bulk", { orderIds }, { timeout: 90_000 })
      .then((res) => res.data),

  /** List invoices with pagination and filtering. */
  list: (params?: InvoiceListParams) =>
    apiClient
      .get<PaginatedResponse<Invoice>>("/invoices", { params })
      .then((res) => res.data),

  /** Aggregates for the KPI row and filter-chip counts. */
  stats: (params?: { financialYear?: string }) =>
    apiClient
      .get<InvoiceStats>("/invoices/stats", { params })
      .then((res) => res.data),

  /** Get full invoice detail. */
  get: (id: string) =>
    apiClient
      .get<InvoiceDetail>(`/invoices/${id}`)
      .then((res) => res.data),

  /** GET /invoices/:id/pdf — the invoice as the PDF customers are sent. */
  pdf: (id: string) =>
    apiClient
      .get<Blob>(`/invoices/${id}/pdf`, { responseType: "blob" })
      .then((res) => res.data),

  /** Cancel an issued invoice. */
  cancel: (id: string) =>
    apiClient
      .post<Invoice>(`/invoices/${id}/cancel`)
      .then((res) => res.data),

  /** Correct buyer details or notes on an issued invoice. */
  update: (id: string, data: UpdateInvoiceRequest) =>
    apiClient
      .patch<InvoiceDetail>(`/invoices/${id}`, data)
      .then((res) => res.data),

  /** Get GST return summary (GSTR-1 or GSTR-3B). */
  getGstReturn: (params: GstReturnParams) =>
    apiClient
      .get<GstReturnGstr1 | GstReturnGstr3B>("/invoices/gst-return", {
        params,
      })
      .then((res) => res.data),

  /** Export invoices as CSV (returns blob). */
  exportCsv: (params?: InvoiceListParams) =>
    apiClient
      .get("/invoices/export/csv", {
        params,
        responseType: "blob",
      })
      .then((res) => res.data),

  /** Download GST return (GSTR-1 or GSTR-3B) as CSV blob. */
  exportGstReturnCsv: (params: GstReturnParams) =>
    apiClient
      .get("/invoices/gst-return/export/csv", {
        params,
        responseType: "blob",
      })
      .then((res) => res.data),
};
