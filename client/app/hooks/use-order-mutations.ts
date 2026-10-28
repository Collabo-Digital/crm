import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { orderService } from "~/services/order.service";
import { orderKeys } from "~/hooks/use-order-queries";
import { customerKeys } from "~/hooks/use-customer-queries";
import { productKeys } from "~/hooks/use-product-queries";
import { invoiceKeys } from "~/hooks/use-invoice-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import type {
  CreateOfflineOrderRequest,
  UpdateOrderRequest,
  CancelOrderRequest,
  CapturePaymentRequest,
  CreateFulfillmentRequest,
  UpdateTrackingRequest,
} from "~/types/api";

/** Mutation hook for creating an offline (in-store) order with auto-invoice. */
export function useCreateOfflineOrderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateOfflineOrderRequest) =>
      orderService.createOffline(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: orderKeys.all });
      queryClient.invalidateQueries({ queryKey: customerKeys.all });
      queryClient.invalidateQueries({ queryKey: productKeys.all });
      queryClient.invalidateQueries({ queryKey: invoiceKeys.all });
      if (result.invoice) {
        toast.success(`Order ${result.order.name} created with invoice.`);
      } else if (result.invoiceError) {
        toast.success(
          `Order ${result.order.name} created. Invoice skipped: ${result.invoiceError}`,
        );
      } else {
        toast.success(`Order ${result.order.name} created.`);
      }
    },
    onError: (error) =>
      handleMutationError(error, "Failed to create offline order."),
  });
}

// ─── Phase 1: Lifecycle & Metadata mutations ───────────────────────────────
// Each mutation invalidates the affected order's detail + the list so the UI
// reflects the new state without a manual refresh. They all share the same
// error toast handler (server's message is preferred when available).

function invalidateOrder(queryClient: ReturnType<typeof useQueryClient>, id: string) {
  queryClient.invalidateQueries({ queryKey: orderKeys.detail(id) });
  queryClient.invalidateQueries({ queryKey: orderKeys.all });
}

/** PATCH /orders/:id — edit tags / note / contact / addresses / custom attributes. */
export function useUpdateOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrderRequest) => orderService.update(id, data),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      toast.success("Order updated.");
    },
    onError: (error) => handleMutationError(error, "Failed to update order."),
  });
}

/** POST /orders/:id/cancel — cancel an order with optional refund + restock. */
export function useCancelOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CancelOrderRequest) => orderService.cancel(id, data),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      // For Shopify, the cancel runs async — `orders/cancelled` webhook will
      // refine the local state. Phrase the toast accordingly.
      toast.success("Cancellation initiated.");
    },
    onError: (error) => handleMutationError(error, "Failed to cancel order."),
  });
}

/** POST /orders/:id/close — archive a completed order. */
export function useCloseOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => orderService.close(id),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      toast.success("Order archived.");
    },
    onError: (error) => handleMutationError(error, "Failed to close order."),
  });
}

/** POST /orders/:id/open — un-archive a previously closed order. */
export function useOpenOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => orderService.open(id),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      toast.success("Order re-opened.");
    },
    onError: (error) => handleMutationError(error, "Failed to reopen order."),
  });
}

/** POST /orders/:id/mark-paid — flip financial status to PAID. */
export function useMarkOrderPaidMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => orderService.markPaid(id),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      toast.success("Marked as paid.");
    },
    onError: (error) => handleMutationError(error, "Failed to mark order paid."),
  });
}

/** POST /orders/:id/capture — capture an authorized Shopify payment. */
export function useCaptureOrderPaymentMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CapturePaymentRequest) => orderService.capture(id, data),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      toast.success("Payment captured.");
    },
    onError: (error) => handleMutationError(error, "Failed to capture payment."),
  });
}

// ─── Phase 2: Fulfillment & tracking mutations ─────────────────────────────

/** POST /orders/:id/fulfillments — create a fulfillment with optional tracking. */
export function useCreateFulfillmentMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateFulfillmentRequest) =>
      orderService.createFulfillment(id, data),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      queryClient.invalidateQueries({ queryKey: orderKeys.fulfillable(id) });
      toast.success("Fulfilment created.");
    },
    onError: (error) => handleMutationError(error, "The fulfilment was not created."),
  });
}

/** POST /orders/:id/items/status — vendor sets their items to in_progress / on_hold. */
export function useSetItemsStatusMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      status,
      lineItemIds,
      reason,
    }: {
      status: "in_progress" | "on_hold" | "released";
      lineItemIds: string[];
      reason?: string;
    }) => orderService.setItemsStatus(id, status, lineItemIds, reason),
    onSuccess: (_data, variables) => {
      invalidateOrder(queryClient, id);
      toast.success(
        variables.status === "on_hold"
          ? "Put on hold."
          : variables.status === "released"
            ? "Hold released."
            : "Marked in progress.",
      );
    },
    onError: (error) => handleMutationError(error, "Failed to update items."),
  });
}

/** POST /orders/:id/items/:lineId/delivered — vendor marks one product delivered. */
export function useMarkDeliveredMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => orderService.markItemDelivered(id, lineId),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      toast.success("Marked as delivered.");
    },
    onError: (error) => handleMutationError(error, "Failed to mark delivered."),
  });
}

/** POST /orders/:id/items/:lineId/unfulfill — vendor switches one product back to unfulfilled. */
export function useUnfulfillMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => orderService.unfulfillItem(id, lineId),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      queryClient.invalidateQueries({ queryKey: orderKeys.fulfillable(id) });
      toast.success("Switched back to unfulfilled.");
    },
    onError: (error) => handleMutationError(error, "It was not switched back to unfulfilled."),
  });
}

/** PATCH /orders/:id/items/:lineId/tracking — add/update tracking for one product. */
export function useUpdateItemTrackingMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, data }: { lineId: string; data: UpdateTrackingRequest }) =>
      orderService.updateItemTracking(id, lineId, data),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      toast.success("Tracking saved.");
    },
    onError: (error) => handleMutationError(error, "Failed to save tracking."),
  });
}

/** PATCH /orders/:id/fulfillments/:fid/tracking — update tracking info. */
export function useUpdateTrackingMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fulfillmentId, data }: { fulfillmentId: string; data: UpdateTrackingRequest }) =>
      orderService.updateTracking(id, fulfillmentId, data),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      toast.success("Tracking updated.");
    },
    onError: (error) => handleMutationError(error, "Failed to update tracking."),
  });
}

/** POST /orders/:id/fulfillments/:fid/delivered — mark a whole shipment delivered. */
export function useMarkFulfillmentDeliveredMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fulfillmentId: string) =>
      orderService.markFulfillmentDelivered(id, fulfillmentId),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      queryClient.invalidateQueries({ queryKey: orderKeys.fulfillable(id) });
      toast.success("Shipment marked as delivered.");
    },
    onError: (error) => handleMutationError(error, "Failed to mark delivered."),
  });
}

/** POST /orders/:id/fulfillments/:fid/cancel — cancel a fulfillment. */
export function useCancelFulfillmentMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fulfillmentId: string) =>
      orderService.cancelFulfillment(id, fulfillmentId),
    onSuccess: () => {
      invalidateOrder(queryClient, id);
      queryClient.invalidateQueries({ queryKey: orderKeys.fulfillable(id) });
      toast.success("Fulfilment cancelled.");
    },
    onError: (error) => handleMutationError(error, "The fulfilment was not cancelled."),
  });
}

/**
 * POST /orders/:id/sync — manually push a MANUAL offline order to Shopify.
 * The toast text reflects the idempotent server response (already synced,
 * already queued, or newly queued).
 */
export function useSyncOrderMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => orderService.syncToShopify(id),
    onSuccess: (result) => {
      invalidateOrder(queryClient, id);
      if (result.status === "ALREADY_SYNCED") {
        toast.info("Order already synced to Shopify.");
      } else if (result.status === "ALREADY_QUEUED") {
        toast.info("Sync already in progress.");
      } else {
        toast.success("Sync to Shopify queued.");
      }
    },
    onError: (error) => handleMutationError(error, "Failed to sync order."),
  });
}
