import { apiClient } from "~/lib/api-client";
import type {
  AutomationDetail,
  AutomationIssue,
  AutomationListItem,
  AutomationPlatform,
  AutomationRunRow,
  AutomationRunStatus,
  AutomationSettings,
  AutomationStats,
  AutomationStatus,
  AutomationStep,
  AutomationTestResult,
  CartDiscountUpdate,
  CatalogView,
  ConversationStarters,
  InboxRulesSettings,
  InboxRulesSettingsView,
  InstagramPost,
  PaginatedResponse,
} from "~/types/api";

/** Service layer for automations (`/automations/*`) and the inbox's own rules (`/inbox/settings`). */
export const automationsService = {
  list: (params: { status?: AutomationStatus; platform?: AutomationPlatform; search?: string; page?: number; limit?: number }) =>
    apiClient.get<PaginatedResponse<AutomationListItem>>("/automations", { params }).then((r) => r.data),
  get: (id: string) => apiClient.get<AutomationDetail>(`/automations/${id}`).then((r) => r.data),
  create: (data: { name: string; platform: AutomationPlatform; channelId: string; description?: string }) =>
    apiClient.post<AutomationDetail>("/automations", data).then((r) => r.data),
  rename: (id: string, data: { name?: string; description?: string }) =>
    apiClient.patch<AutomationDetail>(`/automations/${id}`, data).then((r) => r.data),
  saveDefinition: (id: string, steps: AutomationStep[], settings?: AutomationSettings) =>
    apiClient.put<AutomationDetail>(`/automations/${id}/definition`, { definition: { steps }, ...(settings ? { settings } : {}) }).then((r) => r.data),
  publish: (id: string) => apiClient.post<AutomationDetail>(`/automations/${id}/publish`).then((r) => r.data),
  pause: (id: string) => apiClient.post<AutomationDetail>(`/automations/${id}/pause`).then((r) => r.data),
  resume: (id: string) => apiClient.post<AutomationDetail>(`/automations/${id}/resume`).then((r) => r.data),
  duplicate: (id: string, name?: string) => apiClient.post<AutomationDetail>(`/automations/${id}/duplicate`, { name }).then((r) => r.data),
  archive: (id: string) => apiClient.delete<{ id: string; status: AutomationStatus }>(`/automations/${id}`).then((r) => r.data),
  issues: (id: string) => apiClient.get<AutomationIssue[]>(`/automations/${id}/issues`).then((r) => r.data),
  stats: (id: string) => apiClient.get<AutomationStats>(`/automations/${id}/stats`).then((r) => r.data),
  runs: (id: string, params: { page?: number; status?: AutomationRunStatus }) =>
    apiClient.get<PaginatedResponse<AutomationRunRow>>(`/automations/${id}/runs`, { params }).then((r) => r.data),
  test: (id: string, data: { text?: string; reply?: string; contactId?: string; order?: "cod" | "prepaid" }) =>
    apiClient.post<AutomationTestResult>(`/automations/${id}/test`, data).then((r) => r.data),
  /** Turns on the recommended-template automations (by default every one that is on by default); each goes live once its templates are approved. */
  turnOnPack: (keys?: string[]) =>
    apiClient.post<{ automations: AutomationListItem[] }>("/automations/pack/turn-on", keys ? { keys } : {}).then((r) => r.data),
  /** The discount cart recovery's third reminder offers; `cartDiscount: null` removes it, and the reminder with it. */
  saveCartDiscount: (body: CartDiscountUpdate) =>
    apiClient.put<CartDiscountUpdate>("/automations/pack/cart-discount", body).then((r) => r.data),
  posts: (channelId: string, refresh = false) =>
    apiClient
      .get<{ data: InstagramPost[]; syncedAt: string | null; stale: boolean; syncError: string | null }>("/automations/media", {
        params: { channelId, ...(refresh ? { refresh: 1 } : {}) },
      })
      .then((r) => r.data),

  starters: (channelId: string) => apiClient.get<ConversationStarters>(`/automations/starters/${channelId}`).then((r) => r.data),
  saveStarters: (channelId: string, starters: Omit<ConversationStarters, "platform" | "pushedAt">) =>
    apiClient.put<ConversationStarters>(`/automations/starters/${channelId}`, { starters }).then((r) => r.data),

  catalog: (channelId: string) => apiClient.get<CatalogView>(`/commerce/catalog/${channelId}`).then((r) => r.data),
  connectCatalog: (channelId: string, catalogId: string) => apiClient.put<CatalogView>(`/commerce/catalog/${channelId}`, { catalogId }).then((r) => r.data),
  disconnectCatalog: (channelId: string) => apiClient.delete<CatalogView>(`/commerce/catalog/${channelId}`).then((r) => r.data),
  catalogSettings: (channelId: string, data: { catalogVisible?: boolean; cartEnabled?: boolean }) =>
    apiClient.patch<CatalogView>(`/commerce/catalog/${channelId}/settings`, data).then((r) => r.data),
  syncCatalog: (channelId: string) =>
    apiClient
      .post<{ at: string; sent: number; removed: number; skipped: number; errors: number; view: CatalogView }>(`/commerce/catalog/${channelId}/sync`, undefined, { timeout: 180_000 })
      .then((r) => r.data),

  inboxRules: () => apiClient.get<InboxRulesSettingsView>("/inbox/settings").then((r) => r.data),
  saveInboxRules: (settings: InboxRulesSettings) => apiClient.put<InboxRulesSettingsView>("/inbox/settings", { settings }).then((r) => r.data),
};
