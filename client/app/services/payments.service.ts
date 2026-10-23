import { apiClient } from "~/lib/api-client";
import type { ConversationPayments, CreatePaymentLinkRequest, PaymentAccount, PaymentAccountConnected, PaymentLink, WhatsAppPayView } from "~/types/api";

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
  /** WhatsApp Pay: sends the Review and Pay bill in the chat right away. */
  requestWhatsAppPay: (conversationId: string, data: { orderId?: string; draftOrderId?: string }) =>
    apiClient.post<PaymentLink>(`/inbox/conversations/${conversationId}/whatsapp-pay`, data).then((r) => r.data),
  whatsAppPay: (channelId: string) => apiClient.get<WhatsAppPayView>(`/payments/whatsapp-pay/${channelId}`).then((r) => r.data),
  createConfiguration: (channelId: string, data: { name: string; provider: string; redirectUrl?: string }) =>
    apiClient.post<{ oauthUrl: string | null; expiresAt: string | null }>(`/payments/whatsapp-pay/${channelId}/configurations`, data).then((r) => r.data),
  linkConfigurationAgain: (channelId: string, name: string) =>
    apiClient.post<{ oauthUrl: string | null; expiresAt: string | null }>(`/payments/whatsapp-pay/${channelId}/configurations/link`, { name }).then((r) => r.data),
  selectConfiguration: (channelId: string, name: string | null) =>
    apiClient.put<WhatsAppPayView>(`/payments/whatsapp-pay/${channelId}`, { name }).then((r) => r.data),
};
