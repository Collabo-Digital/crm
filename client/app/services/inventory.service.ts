import { apiClient } from "~/lib/api-client";
import type {
  BulkLocationsRequest,
  BulkAdjustmentRequest,
  BulkAdjustmentResponse,
  CodeStatus,
  CreateAdjustmentRequest,
  CreateWarehouseRequest,
  DuplicateCodesReport,
  GenerateCodesRequest,
  GenerateCodesResult,
  InventoryEvent,
  InventoryLookupResult,
  InventoryStatus,
  LabelData,
  LedgerParams,
  PaginatedResponse,
  StockLine,
  StockListParams,
  StockStats,
  UpdateWarehouseRequest,
  VariantStockDetail,
  Warehouse,
  WarehouseLocation,
} from "~/types/api";

/**
 * Service layer for the Inventory V1 (warehousing) endpoints. Each method
 * returns unwrapped response data (the API client strips the envelope).
 */
export const inventoryService = {
  // ── Status / enable ────────────────────────────────────────────────────
  status: () =>
    apiClient.get<InventoryStatus>("/inventory/status").then((r) => r.data),

  enable: () =>
    apiClient
      .post<{ status: "ALREADY_ENABLED" | "SEEDING"; warehouseId?: string }>(
        "/inventory/enable",
      )
      .then((r) => r.data),

  // ── Stock ──────────────────────────────────────────────────────────────
  listStock: (params?: StockListParams) =>
    apiClient
      .get<PaginatedResponse<StockLine>>("/inventory/stock", { params })
      .then((r) => r.data),

  stockStats: (params?: { warehouseId?: string }) =>
    apiClient
      .get<StockStats>("/inventory/stock/stats", { params })
      .then((r) => r.data),

  variantStock: (variantId: string) =>
    apiClient
      .get<VariantStockDetail>(`/inventory/stock/${variantId}`)
      .then((r) => r.data),

  createAdjustment: (data: CreateAdjustmentRequest) =>
    apiClient
      .post<{ ok: boolean; changed: boolean; inventoryQuantity?: number }>(
        "/inventory/adjustments",
        data,
      )
      .then((r) => r.data),

  /** Every edited quantity on one screen, saved at one location atomically. */
  createAdjustmentsBulk: (data: BulkAdjustmentRequest) =>
    apiClient
      .post<BulkAdjustmentResponse>("/inventory/adjustments/bulk", data)
      .then((r) => r.data),

  // ── Ledger / lookup ────────────────────────────────────────────────────
  ledger: (params?: LedgerParams) =>
    apiClient
      .get<PaginatedResponse<InventoryEvent>>("/inventory/ledger", { params })
      .then((r) => r.data),

  lookup: (code: string) =>
    apiClient
      .get<InventoryLookupResult>("/inventory/lookup", { params: { code } })
      .then((r) => r.data),

  // ── SKU / barcode generation ───────────────────────────────────────────
  generateSkus: (data: GenerateCodesRequest) =>
    apiClient
      .post<GenerateCodesResult>("/inventory/labels/generate-skus", data)
      .then((r) => r.data),

  generateBarcodes: (data: GenerateCodesRequest) =>
    apiClient
      .post<GenerateCodesResult>("/inventory/labels/generate-barcodes", data)
      .then((r) => r.data),

  /** Org-wide code coverage. Not location-scoped — codes belong to the catalogue. */
  codeStatus: () =>
    apiClient
      .get<CodeStatus>("/inventory/labels/code-status")
      .then((r) => r.data),

  duplicates: () =>
    apiClient
      .get<DuplicateCodesReport>("/inventory/labels/duplicates")
      .then((r) => r.data),

  labelData: (variantIds: string[]) =>
    apiClient
      .get<LabelData[]>("/inventory/labels/data", {
        params: { variantIds: variantIds.join(",") },
      })
      .then((r) => r.data),

  // ── Warehouses ─────────────────────────────────────────────────────────
  warehouses: () =>
    apiClient.get<Warehouse[]>("/warehouses").then((r) => r.data),

  createWarehouse: (data: CreateWarehouseRequest) =>
    apiClient.post<Warehouse>("/warehouses", data).then((r) => r.data),

  updateWarehouse: (id: string, data: UpdateWarehouseRequest) =>
    apiClient.patch<Warehouse>(`/warehouses/${id}`, data).then((r) => r.data),

  warehouseLocations: (id: string) =>
    apiClient
      .get<WarehouseLocation[]>(`/warehouses/${id}/locations`)
      .then((r) => r.data),

  bulkCreateLocations: (id: string, data: BulkLocationsRequest) =>
    apiClient
      .post<{ ok: boolean; created: number }>(`/warehouses/${id}/locations/bulk`, data)
      .then((r) => r.data),
};
