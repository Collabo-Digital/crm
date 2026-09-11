import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { inventoryService } from "~/services/inventory.service";
import type { LedgerParams, StockListParams } from "~/types/api";

/** React Query key factory for all inventory-related queries. */
export const inventoryKeys = {
  all: ["inventory"] as const,
  status: () => [...inventoryKeys.all, "status"] as const,
  stock: (params?: StockListParams) => [...inventoryKeys.all, "stock", params] as const,
  stockStats: (params?: { warehouseId?: string }) =>
    [...inventoryKeys.all, "stock-stats", params] as const,
  variantStock: (variantId: string) =>
    [...inventoryKeys.all, "variant-stock", variantId] as const,
  ledger: (params?: LedgerParams) => [...inventoryKeys.all, "ledger", params] as const,
  duplicates: () => [...inventoryKeys.all, "duplicates"] as const,
  warehouses: () => [...inventoryKeys.all, "warehouses"] as const,
  locations: (warehouseId: string) =>
    [...inventoryKeys.all, "locations", warehouseId] as const,
};

/**
 * Warehousing status for the current org. Polls every 3s while the enable
 * seed is running (self-terminating, same pattern as the product sync poll).
 */
export function useInventoryStatus() {
  return useQuery({
    queryKey: inventoryKeys.status(),
    queryFn: () => inventoryService.status(),
    refetchInterval: (query) => (query.state.data?.seeding ? 3000 : false),
  });
}

export function useStock(params?: StockListParams, enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.stock(params),
    queryFn: () => inventoryService.listStock(params),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * Aggregate stock figures, scoped to one warehouse when `warehouseId` is set
 * and org-wide when it is not. The warehouse sits in the query key so each one
 * caches separately; `keepPreviousData` holds the last figures on screen while
 * the next warehouse loads, instead of flashing the tiles back to skeletons.
 */
export function useStockStats(params?: { warehouseId?: string }, enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.stockStats(params),
    queryFn: () => inventoryService.stockStats(params),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useVariantStock(variantId?: string | null) {
  return useQuery({
    queryKey: inventoryKeys.variantStock(variantId!),
    queryFn: () => inventoryService.variantStock(variantId!),
    enabled: !!variantId,
  });
}

export function useInventoryLedger(params?: LedgerParams, enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.ledger(params),
    queryFn: () => inventoryService.ledger(params),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useDuplicateCodes(enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.duplicates(),
    queryFn: () => inventoryService.duplicates(),
    enabled,
  });
}

export function useWarehouses(enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.warehouses(),
    queryFn: () => inventoryService.warehouses(),
    enabled,
  });
}

export function useWarehouseLocations(warehouseId?: string | null) {
  return useQuery({
    queryKey: inventoryKeys.locations(warehouseId!),
    queryFn: () => inventoryService.warehouseLocations(warehouseId!),
    enabled: !!warehouseId,
  });
}
