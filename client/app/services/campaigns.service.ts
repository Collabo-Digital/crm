import { apiClient } from "~/lib/api-client";
import type {
  Broadcast,
  BroadcastDetail,
  BroadcastPreview,
  BroadcastRecipientRow,
  BroadcastRecipientStatus,
  BroadcastStatus,
  CampaignUpload,
  CampaignsOverview,
  ContactImportMapping,
  ContactImportPreview,
  ContactImportResult,
  InboxSendOutcome,
  MessageRate,
  MessageTemplate,
  PaginatedResponse,
  RfmGroup,
  Segment,
  SegmentDefinition,
  SegmentPreview,
  TemplateDraft,
  TemplateStarter,
} from "~/types/api";

export interface SaveBroadcastRequest {
  name?: string;
  campaign?: string | null;
  templateId?: string | null;
  variables?: Broadcast["variables"];
  audience?: Broadcast["audience"];
}

/**
 * Service layer for Campaigns (`/campaigns/*`) and the contact import that
 * feeds it (`/inbox/contacts/import*`).
 */
export const campaignsService = {
  overview: () => apiClient.get<CampaignsOverview>("/campaigns/overview").then((r) => r.data),

  // ─── Templates ──────────────────────────────────────────────────────
  listTemplates: (params: { status?: string; category?: string; search?: string } = {}) =>
    apiClient.get<MessageTemplate[]>("/campaigns/templates", { params }).then((r) => r.data),
  getTemplate: (id: string) => apiClient.get<MessageTemplate>(`/campaigns/templates/${id}`).then((r) => r.data),
  starters: () => apiClient.get<TemplateStarter[]>("/campaigns/templates/starters").then((r) => r.data),
  syncTemplates: () =>
    apiClient.post<{ synced: number; removed: number }>("/campaigns/templates/sync", undefined, { timeout: 120_000 }).then((r) => r.data),
  createTemplate: (draft: TemplateDraft, starterKey?: string) =>
    apiClient.post<MessageTemplate>("/campaigns/templates", { draft, starterKey }, { timeout: 120_000 }).then((r) => r.data),
  updateTemplate: (id: string, draft: TemplateDraft) =>
    apiClient.patch<MessageTemplate>(`/campaigns/templates/${id}`, { draft }, { timeout: 120_000 }).then((r) => r.data),
  deleteTemplate: (id: string) => apiClient.delete<{ deleted: true }>(`/campaigns/templates/${id}`).then((r) => r.data),
  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiClient
      .post<CampaignUpload>("/campaigns/uploads", form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 })
      .then((r) => r.data);
  },

  // ─── Segments ───────────────────────────────────────────────────────
  listSegments: () => apiClient.get<Segment[]>("/campaigns/segments").then((r) => r.data),
  getSegment: (id: string) => apiClient.get<Segment>(`/campaigns/segments/${id}`).then((r) => r.data),
  previewSegment: (definition: SegmentDefinition) =>
    apiClient.post<SegmentPreview>("/campaigns/segments/preview", { definition }).then((r) => r.data),
  rfmSummary: () => apiClient.get<Partial<Record<RfmGroup, number>>>("/campaigns/segments/rfm").then((r) => r.data),
  createSegment: (data: { name: string; description?: string | null; definition: SegmentDefinition }) =>
    apiClient.post<Segment>("/campaigns/segments", data).then((r) => r.data),
  updateSegment: (id: string, data: { name?: string; description?: string | null; definition?: SegmentDefinition }) =>
    apiClient.patch<Segment>(`/campaigns/segments/${id}`, data).then((r) => r.data),
  deleteSegment: (id: string) => apiClient.delete<{ deleted: true }>(`/campaigns/segments/${id}`).then((r) => r.data),

  // ─── Broadcasts ─────────────────────────────────────────────────────
  listBroadcasts: (params: { status?: BroadcastStatus; search?: string; page?: number; limit?: number }) =>
    apiClient.get<PaginatedResponse<Broadcast>>("/campaigns/broadcasts", { params }).then((r) => r.data),
  getBroadcast: (id: string) => apiClient.get<BroadcastDetail>(`/campaigns/broadcasts/${id}`).then((r) => r.data),
  createBroadcast: (data: SaveBroadcastRequest) => apiClient.post<BroadcastDetail>("/campaigns/broadcasts", data).then((r) => r.data),
  updateBroadcast: (id: string, data: SaveBroadcastRequest) =>
    apiClient.patch<BroadcastDetail>(`/campaigns/broadcasts/${id}`, data).then((r) => r.data),
  deleteBroadcast: (id: string) => apiClient.delete<{ deleted: true }>(`/campaigns/broadcasts/${id}`).then((r) => r.data),
  duplicateBroadcast: (id: string) => apiClient.post<BroadcastDetail>(`/campaigns/broadcasts/${id}/duplicate`).then((r) => r.data),
  previewBroadcast: (id: string) =>
    apiClient.post<BroadcastPreview>(`/campaigns/broadcasts/${id}/preview`, undefined, { timeout: 120_000 }).then((r) => r.data),
  testBroadcast: (id: string, phone: string) =>
    apiClient.post<InboxSendOutcome>(`/campaigns/broadcasts/${id}/test`, { phone }).then((r) => r.data),
  sendBroadcast: (id: string, scheduledAt?: string) =>
    apiClient
      .post<BroadcastDetail>(`/campaigns/broadcasts/${id}/send`, scheduledAt ? { scheduledAt } : {}, { timeout: 120_000 })
      .then((r) => r.data),
  cancelBroadcast: (id: string) => apiClient.post<BroadcastDetail>(`/campaigns/broadcasts/${id}/cancel`).then((r) => r.data),
  retryBroadcast: (id: string) =>
    apiClient.post<{ retrying: number; notRetryable: number }>(`/campaigns/broadcasts/${id}/retry`).then((r) => r.data),
  recipients: (id: string, params: { status?: BroadcastRecipientStatus; page?: number; limit?: number }) =>
    apiClient
      .get<PaginatedResponse<BroadcastRecipientRow>>(`/campaigns/broadcasts/${id}/recipients`, { params })
      .then((r) => r.data),

  // ─── Rates ──────────────────────────────────────────────────────────
  listRates: () => apiClient.get<MessageRate[]>("/campaigns/rates").then((r) => r.data),
  replaceRates: (rows: MessageRate[]) => apiClient.put<MessageRate[]>("/campaigns/rates", { rows }).then((r) => r.data),

  // ─── Contact import ─────────────────────────────────────────────────
  previewImport: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiClient
      .post<ContactImportPreview>("/inbox/contacts/import/preview", form, { headers: { "Content-Type": "multipart/form-data" } })
      .then((r) => r.data);
  },
  runImport: (file: File, mapping: ContactImportMapping, options: { defaultCountryCode?: string; tags?: string[]; markOptedIn?: boolean }) => {
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(mapping));
    form.append("options", JSON.stringify(options));
    return apiClient
      .post<ContactImportResult>("/inbox/contacts/import", form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 300_000 })
      .then((r) => r.data);
  },

  /** Approved templates for the inbox composer (chat section, no campaign access needed). */
  inboxTemplates: () => apiClient.get<MessageTemplate[]>("/inbox/templates").then((r) => r.data),
};
