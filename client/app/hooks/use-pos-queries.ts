import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { posService } from "~/services/pos.service";

export const posKeys = {
  all: ["pos"] as const,
  setup: (storeId?: string) => [...posKeys.all, "setup", storeId ?? null] as const,
  staff: () => [...posKeys.all, "staff"] as const,
  products: (search: string, storeId?: string) => [...posKeys.all, "products", search, storeId ?? null] as const,
  customers: (search: string) => [...posKeys.all, "customers", search] as const,
  receipt: (orderId: string) => [...posKeys.all, "receipt", orderId] as const,
};

/** Settings, stores, active staff and quick tiles for the till. */
export function usePosSetup(storeId?: string, enabled = true) {
  return useQuery({
    queryKey: posKeys.setup(storeId),
    queryFn: () => posService.setup(storeId),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Every POS staff member, active or not. Managers only. */
export function usePosStaff(enabled = true) {
  return useQuery({ queryKey: posKeys.staff(), queryFn: posService.staff, enabled });
}

export function usePosProducts(search: string, storeId?: string) {
  const term = search.trim();
  return useQuery({
    queryKey: posKeys.products(term, storeId),
    queryFn: () => posService.products({ search: term, storeId, limit: 20 }),
    enabled: term.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** The server searches from three characters. */
export function usePosCustomers(search: string) {
  const term = search.trim();
  return useQuery({
    queryKey: posKeys.customers(term),
    queryFn: () => posService.customers(term),
    enabled: term.length >= 3,
    placeholderData: keepPreviousData,
  });
}

export function usePosReceipt(orderId: string | undefined) {
  return useQuery({
    queryKey: posKeys.receipt(orderId ?? ""),
    queryFn: () => posService.receipt(orderId!),
    enabled: !!orderId,
    // A receipt is printed once; a refetch on focus would only reprint.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
