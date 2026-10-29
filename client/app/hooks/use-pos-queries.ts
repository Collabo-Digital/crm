import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { posService } from "~/services/pos.service";
import type { PosBillState } from "~/types/api";

export const posKeys = {
  all: ["pos"] as const,
  setup: (storeId?: string) => [...posKeys.all, "setup", storeId ?? null] as const,
  staff: () => [...posKeys.all, "staff"] as const,
  products: (search: string, storeId?: string) => [...posKeys.all, "products", search, storeId ?? null] as const,
  customers: (search: string) => [...posKeys.all, "customers", search] as const,
  receipt: (orderId: string) => [...posKeys.all, "receipt", orderId] as const,
  delivery: (orderId: string, since: number) => [...posKeys.all, "delivery", orderId, since] as const,
  publicBill: (token: string) => ["public-bill", token] as const,
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

const POLL_MS = 2_000;
const POLL_FOR_MS = 60_000;

/** True while a message is still on its way. */
export function deliveryInFlight(state: PosBillState | undefined): boolean {
  return !!state?.delivery.some((d) => d.status === "sending" || d.status === "sent");
}

/** Read, Not sent and Failed are final; Delivered can still turn into Read. */
function deliveryFinal(state: PosBillState | undefined): boolean {
  return !state?.delivery.some((d) => d.status === "sending" || d.status === "sent" || d.status === "delivered");
}

/**
 * A sale's bill delivery, starting from `initial` (what the sale or the last
 * send returned at `since`), polled every 2 s until it is final, for at most
 * a minute.
 */
export function usePosDelivery(orderId: string, initial: PosBillState, since: number) {
  return useQuery({
    queryKey: posKeys.delivery(orderId, since),
    queryFn: () => posService.delivery(orderId),
    initialData: initial,
    initialDataUpdatedAt: since,
    staleTime: POLL_MS,
    refetchInterval: (query) => (!deliveryFinal(query.state.data) && Date.now() - since < POLL_FOR_MS ? POLL_MS : false),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
  });
}

/** The customer's bill behind a public link. A 404 or 410 means the link is wrong or expired. */
export function usePublicBill(token: string | undefined) {
  return useQuery({
    queryKey: posKeys.publicBill(token ?? ""),
    queryFn: () => posService.publicBill(token!),
    enabled: !!token,
    // A wrong or expired link stays wrong; only a dropped connection is worth retrying.
    retry: (count, error) => {
      const status = isAxiosError(error) ? (error.response?.status ?? 0) : 0;
      return count < 2 && !(status >= 400 && status < 500);
    },
    refetchOnWindowFocus: false,
  });
}
