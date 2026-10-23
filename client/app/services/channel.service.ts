import { apiClient } from "~/lib/api-client";
import type {
  Channel,
  ChannelDetail,
  UpdateChannelRequest,
  TriggerSyncRequest,
  ChannelSyncSettings,
  UpdateSyncSettingsRequest,
  SyncLog,
  ShopifyInstallRequest,
  OAuthInstallResponse,
  ManualConnectShopifyRequest,
  ManualConnectShopifyResponse,
  WhatsAppInstallRequest,
  WhatsAppInstallResponse,
  WhatsAppCallbackRequest,
  WhatsAppCallbackResponse,
  InstagramInstallRequest,
  InstagramPendingResponse,
  CompleteInstagramRequest,
  CompleteInstagramResponse,
} from "~/types/api";

/**
 * Service layer for channel API endpoints.
 *
 * Each method returns the unwrapped response data (the API client
 * already strips the `{ success, data }` envelope).
 */
export const channelService = {
  list: () =>
    apiClient.get<Channel[]>("/channels").then((response) => response.data),

  get: (id: string) =>
    apiClient.get<ChannelDetail>(`/channels/${id}`).then((response) => response.data),

  update: (id: string, data: UpdateChannelRequest) =>
    apiClient.patch<Channel>(`/channels/${id}`, data).then((response) => response.data),

  disconnect: (id: string) =>
    apiClient.delete<{ message: string }>(`/channels/${id}`).then((response) => response.data),

  triggerSync: (id: string, data: TriggerSyncRequest) =>
    apiClient.post<{ message: string; jobId: string }>(`/channels/${id}/sync`, data).then((response) => response.data),

  /** Sync history — the only place a failed sync explains itself. */
  getSyncLogs: (id: string) =>
    apiClient.get<SyncLog[]>(`/channels/${id}/sync-logs`).then((response) => response.data),

  getSyncSettings: (id: string) =>
    apiClient.get<ChannelSyncSettings>(`/channels/${id}/sync-settings`).then((response) => response.data),

  updateSyncSettings: (id: string, data: UpdateSyncSettingsRequest) =>
    apiClient.patch<ChannelSyncSettings>(`/channels/${id}/sync-settings`, data).then((response) => response.data),

  installShopify: (data: ShopifyInstallRequest) =>
    apiClient.post<OAuthInstallResponse>("/channels/shopify/install", data).then((response) => response.data),

  /** Manually connect a Shopify store using custom app credentials. */
  manualConnectShopify: (data: ManualConnectShopifyRequest) =>
    apiClient.post<ManualConnectShopifyResponse>("/channels/shopify/manual-connect", data).then((response) => response.data),

  /**
   * Start Facebook Login for Instagram. Pass `reconnectChannelId` to re-authorize
   * an existing account rather than add another one.
   */
  installInstagram: (data: InstagramInstallRequest = {}) =>
    apiClient.post<OAuthInstallResponse>("/channels/instagram/install", data).then((response) => response.data),

  /** The accounts one Facebook login granted, when the merchant must pick one. */
  getInstagramPending: (pendingId: string) =>
    apiClient.get<InstagramPendingResponse>(`/channels/instagram/pending/${pendingId}`).then((response) => response.data),

  /** Connect the Instagram account the merchant picked. */
  completeInstagramInstall: (data: CompleteInstagramRequest) =>
    apiClient.post<CompleteInstagramResponse>("/channels/instagram/complete", data).then((response) => response.data),

  /** Step 1 of WhatsApp Embedded Signup: get the configId + CSRF state to feed into FB.login. */
  installWhatsApp: (data: WhatsAppInstallRequest = {}) =>
    apiClient.post<WhatsAppInstallResponse>("/channels/whatsapp/install", data).then((response) => response.data),

  /** Step 2 of WhatsApp Embedded Signup: forward the code Meta returned to the backend. */
  completeWhatsAppInstall: (data: WhatsAppCallbackRequest) =>
    apiClient.post<WhatsAppCallbackResponse>("/channels/whatsapp/callback", data).then((response) => response.data),
};
