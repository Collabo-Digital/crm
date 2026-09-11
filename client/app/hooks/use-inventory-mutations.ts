import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { inventoryService } from "~/services/inventory.service";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { inventoryKeys } from "./use-inventory-queries";
import { productKeys } from "./use-product-queries";
import type {
  BulkAdjustmentRequest,
  BulkLocationsRequest,
  CreateAdjustmentRequest,
  CreateWarehouseRequest,
  GenerateCodesRequest,
  UpdateWarehouseRequest,
} from "~/types/api";

/**
 * Inventory mutations. Every stock-touching mutation invalidates BOTH the
 * inventory prefix and the products prefix — the products list/detail screens
 * render variant.inventoryQuantity (the sellable cache) and must refresh.
 */

export function useEnableInventoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => inventoryService.enable(),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      if (res.status === "SEEDING") {
        toast.success("Warehousing is being set up — seeding stock from your catalog.");
      }
    },
    onError: (error) => handleMutationError(error, "Failed to enable warehousing."),
  });
}

/**
 * `silent` hands the toast and the error to the caller. The variant editor
 * fires one adjustment per changed warehouse inside a larger save, so the
 * default per-call toast would stack three "Stock adjusted." on top of its own
 * result, and its own catch needs the rejection to reach it.
 */
export function useCreateAdjustmentMutation(options: { silent?: boolean } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAdjustmentRequest) => inventoryService.createAdjustment(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      if (!options.silent) toast.success("Stock adjusted.");
    },
    onError: (error) => {
      if (!options.silent) handleMutationError(error, "Failed to adjust stock.");
    },
  });
}

/**
 * Saves a screenful of edited quantities in one call.
 *
 * The server applies them atomically, so a rejection means nothing was written
 * and the merchant's edits are all still on screen to correct or discard —
 * which is why the error is handed back to the caller rather than toasted here.
 */
export function useBulkAdjustmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: BulkAdjustmentRequest) =>
      inventoryService.createAdjustmentsBulk(data),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      toast.success(
        res.applied === 1
          ? "1 quantity updated."
          : `${res.applied} quantities updated.`,
      );
    },
  });
}

/**
 * The response cannot tell us how many were left alone: the service filters
 * out anything that already has a code BEFORE counting, so `skipped` comes
 * back as `variants.length - generated` — always 0. When the caller named an
 * explicit set of variants we can work it out ourselves, since React Query
 * hands the mutation variables to onSuccess alongside the result.
 *
 * Reported as "unchanged" rather than "already had one": existing codes
 * dominate the difference, but it also absorbs variants deleted between render
 * and submit, and the toast should not assert a reason it cannot verify.
 */
function unchangedCount(vars: GenerateCodesRequest, accountedFor: number): number {
  const asked = vars.variantIds?.length;
  if (!asked) return 0;
  return Math.max(0, asked - accountedFor);
}

export function useGenerateSkusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: GenerateCodesRequest) => inventoryService.generateSkus(data),
    onSuccess: (res, variables) => {
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      const unchanged = unchangedCount(variables, res.generated);
      toast.success(
        `Generated ${res.generated} SKU${res.generated === 1 ? "" : "s"}` +
          (unchanged > 0 ? ` · ${unchanged} unchanged` : "") + ".",
      );
    },
    onError: (error) => handleMutationError(error, "Failed to generate SKUs."),
  });
}

export function useGenerateBarcodesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: GenerateCodesRequest) => inventoryService.generateBarcodes(data),
    onSuccess: (res, variables) => {
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      // `skipped` IS meaningful here (unlike SKUs): generateBarcodes records a
      // real conflict for every variant that has no SKU to copy from. Those
      // are already accounted for, so only the remainder is "unchanged".
      const unchanged = unchangedCount(variables, res.generated + res.skipped);
      toast.success(
        `Generated ${res.generated} barcode${res.generated === 1 ? "" : "s"}` +
          (res.skipped > 0 ? ` · ${res.skipped} need a SKU first` : "") +
          (unchanged > 0 ? ` · ${unchanged} unchanged` : "") + ".",
      );
    },
    onError: (error) => handleMutationError(error, "Failed to generate barcodes."),
  });
}

export function useCreateWarehouseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWarehouseRequest) => inventoryService.createWarehouse(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      toast.success("Warehouse created.");
    },
    onError: (error) => handleMutationError(error, "Failed to create warehouse."),
  });
}

export function useUpdateWarehouseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateWarehouseRequest }) =>
      inventoryService.updateWarehouse(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      toast.success("Warehouse updated.");
    },
    onError: (error) => handleMutationError(error, "Failed to update warehouse."),
  });
}

export function useBulkCreateLocationsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: BulkLocationsRequest }) =>
      inventoryService.bulkCreateLocations(id, data),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      toast.success(`Created ${res.created} locations.`);
    },
    onError: (error) => handleMutationError(error, "Failed to create locations."),
  });
}
