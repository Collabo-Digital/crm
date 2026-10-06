import { apiClient } from "~/lib/api-client";
import { warnIfExportCutOff } from "~/lib/export-notice";
import type {
  PaginatedResponse,
  Order,
  OrderDetail,
  OrderFulfillment,
  OrderListParams,
  OrderSlipData,
  OrderStatsResponse,
  AdjacentOrders,
  DashboardQueryParams,
  CreateOfflineOrderRequest,
  CreateOfflineOrderResponse,
  UpdateOrderRequest,
  CancelOrderRequest,
  CapturePaymentRequest,
  CreateFulfillmentRequest,
  UpdateTrackingRequest,
  FulfillableLineItemsResponse,
  ManualSyncResponse,
} from "~/types/api";

// A file download outlasts a page request; the 30 s default cut large
// exports off. Same allowance as the dashboard exports.
const EXPORT_TIMEOUT_MS = 120_000;

/**
 * Service layer for order API endpoints.
 *
 * Each method returns the unwrapped response data (the API client
 * already strips the `{ success, data }` envelope).
 */
export const orderService = {
  list: (params?: OrderListParams) =>
    apiClient.get<PaginatedResponse<Order>>("/orders", { params }).then((response) => response.data),

  get: (id: string) =>
    apiClient.get<OrderDetail>(`/orders/${id}`).then((response) => response.data),

  adjacent: (id: string) =>
    apiClient.get<AdjacentOrders>(`/orders/${id}/adjacent`).then((response) => response.data),

  /**
   * Package-slip payload for many orders in one request, for the batch print
   * route. Ids go as one comma-separated param, matching
   * `inventoryService.labelData`. The server caps the batch at 100 and orders
   * the result by order number, so a printed stack comes out predictably.
   */
  slipData: (orderIds: string[]) =>
    apiClient
      .get<OrderSlipData[]>("/orders/slips/data", {
        params: { orderIds: orderIds.join(",") },
      })
      .then((response) => response.data),

  stats: (params?: DashboardQueryParams) =>
    apiClient.get<OrderStatsResponse>("/orders/stats", { params }).then((response) => response.data),

  createOffline: (data: CreateOfflineOrderRequest) =>
    apiClient.post<CreateOfflineOrderResponse>("/orders/offline", data).then((response) => response.data),

  // ─── Phase 1: Lifecycle & metadata ─────────────────────────────────────

  update: (id: string, data: UpdateOrderRequest) =>
    apiClient.patch<Order>(`/orders/${id}`, data).then((response) => response.data),

  cancel: (id: string, data: CancelOrderRequest) =>
    apiClient.post<Order>(`/orders/${id}/cancel`, data).then((response) => response.data),

  close: (id: string) =>
    apiClient.post<Order>(`/orders/${id}/close`).then((response) => response.data),

  open: (id: string) =>
    apiClient.post<Order>(`/orders/${id}/open`).then((response) => response.data),

  markPaid: (id: string) =>
    apiClient.post<Order>(`/orders/${id}/mark-paid`).then((response) => response.data),

  capture: (id: string, data: CapturePaymentRequest) =>
    apiClient.post<Order>(`/orders/${id}/capture`, data).then((response) => response.data),

  // ─── Phase 2: Fulfillment & tracking ───────────────────────────────────

  fulfillableLineItems: (id: string) =>
    apiClient
      .get<FulfillableLineItemsResponse>(`/orders/${id}/fulfillable-line-items`)
      .then((response) => response.data),

  createFulfillment: (id: string, data: CreateFulfillmentRequest) =>
    apiClient
      .post<OrderFulfillment>(`/orders/${id}/fulfillments`, data)
      .then((response) => response.data),

  // Vendor: set their own line items' status (on_hold with reason / released).
  setItemsStatus: (
    id: string,
    status: "in_progress" | "on_hold" | "released",
    lineItemIds: string[],
    reason?: string,
  ) =>
    apiClient
      .post<{ updated: number; status: string }>(`/orders/${id}/items/status`, {
        status,
        lineItemIds,
        reason,
      })
      .then((response) => response.data),

  // Vendor: mark ONE product delivered (updates the app + Shopify).
  markItemDelivered: (id: string, lineId: string) =>
    apiClient
      .post<{ id: string; status: string }>(`/orders/${id}/items/${lineId}/delivered`)
      .then((response) => response.data),

  // Vendor: switch ONE product back to unfulfilled (updates the app + Shopify).
  unfulfillItem: (id: string, lineId: string) =>
    apiClient
      .post<{ id: string; status: string }>(`/orders/${id}/items/${lineId}/unfulfill`)
      .then((response) => response.data),

  // Add / update tracking for ONE product (updates the app + Shopify).
  updateItemTracking: (id: string, lineId: string, data: UpdateTrackingRequest) =>
    apiClient
      .patch<OrderFulfillment>(`/orders/${id}/items/${lineId}/tracking`, data)
      .then((response) => response.data),

  updateTracking: (id: string, fid: string, data: UpdateTrackingRequest) =>
    apiClient
      .patch<OrderFulfillment>(`/orders/${id}/fulfillments/${fid}/tracking`, data)
      .then((response) => response.data),

  // Mark a whole shipment delivered. The endpoint has existed and been
  // vendor-scoped since fulfilments shipped, but had no client method at all,
  // so shipment-level delivery was unreachable from the UI — only the per-line
  // `markItemDelivered` above was wired.
  markFulfillmentDelivered: (id: string, fid: string) =>
    apiClient
      .post<OrderFulfillment>(`/orders/${id}/fulfillments/${fid}/delivered`)
      .then((response) => response.data),

  cancelFulfillment: (id: string, fid: string) =>
    apiClient
      .post<OrderFulfillment>(`/orders/${id}/fulfillments/${fid}/cancel`)
      .then((response) => response.data),

  // Manual sync — push an offline (MANUAL) order to Shopify on demand.
  syncToShopify: (id: string) =>
    apiClient
      .post<ManualSyncResponse>(`/orders/${id}/sync`)
      .then((response) => response.data),

  /**
   * Export orders as a JSON report: `generatedAt`, `filters`, `totalOrders`,
   * the rows, and a `truncated` note when the server's row cap was hit.
   *
   * Typed to the filters the export route actually applies. It takes the
   * list DTO, but ignores `search`, `page` and `limit`, so accepting
   * `OrderListParams` here let the page send a search it could not honour.
   */
  exportJson: (params?: OrderExportParams) =>
    apiClient
      .get<Blob>("/orders/export/json", { params, responseType: "blob", timeout: EXPORT_TIMEOUT_MS })
      .then((response) => {
        // The server caps the file; say so when it held back older orders.
        warnIfExportCutOff(response.headers);
        return response.data;
      }),
};

export type OrderExportParams = Pick<
  OrderListParams,
  "financialStatus" | "fulfillmentStatus" | "channelId" | "dateFrom" | "dateTo"
>;
