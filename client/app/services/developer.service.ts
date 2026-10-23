import { apiClient } from "~/lib/api-client";
import type { ApiKeyView, WebhookDeliveryView, WebhookEndpointView } from "~/types/api";

/** Settings → Developers: API keys and outgoing webhooks (owners and admins). */
export const developerService = {
  catalog: () => apiClient.get<{ scopes: string[]; events: string[] }>("/developers/catalog").then((r) => r.data),
  keys: () => apiClient.get<ApiKeyView[]>("/developers/keys").then((r) => r.data),
  createKey: (data: { name: string; scopes: string[] }) => apiClient.post<ApiKeyView>("/developers/keys", data).then((r) => r.data),
  revokeKey: (id: string) => apiClient.delete(`/developers/keys/${id}`),
  webhooks: () => apiClient.get<WebhookEndpointView[]>("/developers/webhooks").then((r) => r.data),
  createWebhook: (data: { url: string; events: string[]; description?: string }) => apiClient.post<WebhookEndpointView>("/developers/webhooks", data).then((r) => r.data),
  updateWebhook: (id: string, data: { enabled?: boolean; events?: string[] }) => apiClient.patch<WebhookEndpointView>(`/developers/webhooks/${id}`, data).then((r) => r.data),
  removeWebhook: (id: string) => apiClient.delete(`/developers/webhooks/${id}`),
  rotateSecret: (id: string) => apiClient.post<{ secret: string }>(`/developers/webhooks/${id}/rotate-secret`).then((r) => r.data),
  testWebhook: (id: string) => apiClient.post<{ deliveryId: string }>(`/developers/webhooks/${id}/test`).then((r) => r.data),
  deliveries: (id: string) => apiClient.get<WebhookDeliveryView[]>(`/developers/webhooks/${id}/deliveries`).then((r) => r.data),
};
