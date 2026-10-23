import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { paymentsService } from "~/services/payments.service";
import type { CreatePaymentLinkRequest } from "~/types/api";

export const paymentKeys = {
  all: ["payments"] as const,
  account: () => [...paymentKeys.all, "account"] as const,
  conversation: (id: string) => [...paymentKeys.all, "conversation", id] as const,
};

export function usePaymentAccount() {
  return useQuery({ queryKey: paymentKeys.account(), queryFn: paymentsService.account, staleTime: 60_000 });
}

export function useConnectRazorpayMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: paymentsService.connect,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: paymentKeys.account() }),
    onError: (error) => handleMutationError(error, "Razorpay was not connected."),
  });
}

export function useRotateWebhookSecretMutation() {
  return useMutation({
    mutationFn: paymentsService.rotateWebhookSecret,
    onError: (error) => handleMutationError(error, "A new webhook secret was not made."),
  });
}

export function useDisconnectRazorpayMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: paymentsService.disconnect,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: paymentKeys.account() }),
    onError: (error) => handleMutationError(error, "Razorpay was not disconnected."),
  });
}

/** This chat's payment links and the customer's unpaid orders. Polls while a link is waiting to be paid. */
export function useConversationPayments(conversationId: string, enabled = true) {
  return useQuery({
    queryKey: paymentKeys.conversation(conversationId),
    queryFn: () => paymentsService.forConversation(conversationId),
    enabled,
    refetchInterval: (query) => (query.state.data?.links.some((l) => l.status === "CREATED") ? 30_000 : false),
  });
}

export function useCreatePaymentLinkMutation(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePaymentLinkRequest) => paymentsService.createInConversation(conversationId, data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: paymentKeys.conversation(conversationId) }),
    onError: (error) => handleMutationError(error, "The payment link was not created."),
  });
}

export function usePaymentLinkActionMutation(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "refresh" | "cancel" }) =>
      action === "refresh" ? paymentsService.refresh(id) : paymentsService.cancel(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: paymentKeys.conversation(conversationId) }),
    onError: (error) => handleMutationError(error, "The payment link was not updated."),
  });
}
