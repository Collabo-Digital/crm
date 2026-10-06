import { useQuery } from "@tanstack/react-query";
import { pollWhile } from "~/lib/poll-while";
import { isStalePendingSync, orderShopifySyncOf } from "~/lib/shopify-sync";
import { orderService } from "~/services/order.service";
import type {
  DashboardQueryParams,
  Order,
  OrderDetail,
  OrderListParams,
  PaginatedResponse,
} from "~/types/api";

/** React Query key factory for all order-related queries. */
export const orderKeys = {
  all: ["orders"] as const,
  list: (params?: OrderListParams) => [...orderKeys.all, "list", params] as const,
  detail: (id: string) => [...orderKeys.all, "detail", id] as const,
  stats: (params?: DashboardQueryParams) => [...orderKeys.all, "stats", params] as const,
  fulfillable: (id: string) => [...orderKeys.all, "fulfillable", id] as const,
  adjacent: (id: string) => [...orderKeys.all, "adjacent", id] as const,
  slipData: (ids: string[]) => [...orderKeys.all, "slip-data", ids] as const,
};

/**
 * A push to Shopify is in flight, and not so old that the job is clearly lost.
 *
 * Read through `orderShopifySyncOf`: the list carries the record as
 * `shopifySync`, the detail inside `metadata`. This used to read `metadata`
 * only, which the list endpoint never returned, so the list's polling below
 * never once fired and the page only caught up on a reload.
 */
function isPushPending(order: Pick<Order, "metadata" | "shopifySync"> | undefined): boolean {
  if (!order) return false;
  const sync = orderShopifySyncOf(order);
  return sync?.status === "PENDING" && !isStalePendingSync(sync);
}

// A manual order shows its push to Shopify as pending until the worker
// finishes. Nothing re-read the order afterwards, so the state only changed on
// a page reload.
const pollWhileAnyOrderPushing = pollWhile<PaginatedResponse<Order>>(
  (page) => page?.data.some(isPushPending) ?? false,
);
const pollWhileOrderPushing = pollWhile<OrderDetail>(isPushPending);

/** Fetch a paginated list of orders with optional filters. */
export function useOrders(params?: OrderListParams) {
  return useQuery({
    queryKey: orderKeys.list(params),
    queryFn: () => orderService.list(params),
    refetchInterval: pollWhileAnyOrderPushing,
  });
}

/** Fetch period-over-period order stats (totals + change %). */
export function useOrderStats(params?: DashboardQueryParams) {
  return useQuery({
    queryKey: orderKeys.stats(params),
    queryFn: () => orderService.stats(params),
  });
}

/** Fetch a single order by ID. */
export function useOrder(id?: string | null) {
  return useQuery({
    queryKey: orderKeys.detail(id!),
    queryFn: () => orderService.get(id!),
    enabled: !!id,
    refetchInterval: pollWhileOrderPushing,
  });
}

/**
 * Neighbours of an order for the detail page's Previous / Next rail.
 *
 * Replaces searching a client-side page of orders, which only fetched
 * UNFULFILLED ones — so on a fulfilled order both buttons were dead.
 */
export function useAdjacentOrders(id?: string | null) {
  return useQuery({
    queryKey: orderKeys.adjacent(id!),
    queryFn: () => orderService.adjacent(id!),
    enabled: !!id,
  });
}

/**
 * Fetch the line items still eligible for fulfillment, grouped by
 * fulfillment order (Shopify) or as one bucket (manual). Only invoked when
 * `enabled` is true so we don't hit Shopify on every page render.
 */
export function useFulfillableLineItems(id: string, enabled: boolean) {
  return useQuery({
    queryKey: orderKeys.fulfillable(id),
    queryFn: () => orderService.fulfillableLineItems(id),
    enabled,
    staleTime: 0,
  });
}
