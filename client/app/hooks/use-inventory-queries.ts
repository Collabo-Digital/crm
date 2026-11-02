import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { inventoryService } from "~/services/inventory.service";
import { pollWhile } from "~/lib/poll-while";
import type { InventoryStatus, LedgerParams, StockListParams } from "~/types/api";

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
  codeStatus: () => [...inventoryKeys.all, "code-status"] as const,
  duplicates: () => [...inventoryKeys.all, "duplicates"] as const,
  warehouses: () => [...inventoryKeys.all, "warehouses"] as const,
  locations: (warehouseId: string) =>
    [...inventoryKeys.all, "locations", warehouseId] as const,
};

// The server switches a workspace over to locations by itself and copies its
// stock across; nothing tells the page when that is done.
const pollWhileSettingUp = pollWhile<InventoryStatus>(
  (data) => !!data && !data.warehousingEnabled,
);

/** Locations status for the current org. Polls while the server is still setting them up. */
export function useInventoryStatus() {
  return useQuery({
    queryKey: inventoryKeys.status(),
    queryFn: () => inventoryService.status(),
    refetchInterval: pollWhileSettingUp,
  });
}

/**
 * Counts behind the Product codes dialog. Both generate mutations already
 * invalidate `inventoryKeys.all`, so these refresh after every action with no
 * extra wiring.
 */
export function useCodeStatus(enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.codeStatus(),
    queryFn: () => inventoryService.codeStatus(),
    enabled,
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
