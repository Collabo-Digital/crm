import { apiClient } from "~/lib/api-client";
import type { ConversationPayments, CreatePaymentLinkRequest, PaymentAccount, PaymentAccountConnected, PaymentLink } from "~/types/api";

/** The organization's own Razorpay account and the payment links sent from it. */
export const paymentsService = {
  account: () => apiClient.get<PaymentAccount>("/payments/razorpay").then((r) => r.data),
  connect: (data: { keyId: string; keySecret: string }) =>
    apiClient.post<PaymentAccountConnected>("/payments/razorpay/connect", data).then((r) => r.data),
  rotateWebhookSecret: () => apiClient.post<{ webhookSecret: string }>("/payments/razorpay/rotate-webhook-secret").then((r) => r.data),
  disconnect: () => apiClient.delete("/payments/razorpay"),
  refresh: (id: string) => apiClient.post<PaymentLink>(`/payments/links/${id}/refresh`).then((r) => r.data),
  cancel: (id: string) => apiClient.post<PaymentLink>(`/payments/links/${id}/cancel`).then((r) => r.data),
  forConversation: (conversationId: string) =>
    apiClient.get<ConversationPayments>(`/inbox/conversations/${conversationId}/payment-links`).then((r) => r.data),
  createInConversation: (conversationId: string, data: CreatePaymentLinkRequest) =>
    apiClient.post<PaymentLink>(`/inbox/conversations/${conversationId}/payment-links`, data).then((r) => r.data),
};
