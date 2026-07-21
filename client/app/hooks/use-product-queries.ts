import { useQuery } from "@tanstack/react-query";
import { productService } from "~/services/product.service";
import type { ProductListParams } from "~/types/api";

/** React Query key factory for all product-related queries. */
export const productKeys = {
  all: ["products"] as const,
  list: (params?: ProductListParams) => [...productKeys.all, "list", params] as const,
  detail: (id: string) => [...productKeys.all, "detail", id] as const,
  vendors: () => [...productKeys.all, "vendors"] as const,
  types: () => [...productKeys.all, "types"] as const,
  stats: (params?: { channelId?: string }) => [...productKeys.all, "stats", params] as const,
};

/** Fetch a paginated list of products with optional filters. */
export function useProducts(params?: ProductListParams) {
  return useQuery({
    queryKey: productKeys.list(params),
    queryFn: () => productService.list(params),
  });
}

/** Fetch a single product by ID. */
export function useProduct(id?: string | null) {
  return useQuery({
    queryKey: productKeys.detail(id!),
    queryFn: () => productService.get(id!),
    enabled: !!id,
  });
}

/** Fetch the list of unique product vendors for filter dropdowns. */
export function useProductVendors() {
  return useQuery({
    queryKey: productKeys.vendors(),
    queryFn: () => productService.vendors(),
  });
}

/** Fetch the list of unique product types for filter dropdowns. */
export function useProductTypes() {
  return useQuery({
    queryKey: productKeys.types(),
    queryFn: () => productService.types(),
  });
}

/** Fetch aggregate product statistics. */
export function useProductStats(params?: { channelId?: string }) {
  return useQuery({
    queryKey: productKeys.stats(params),
    queryFn: () => productService.stats(params),
  });
}
