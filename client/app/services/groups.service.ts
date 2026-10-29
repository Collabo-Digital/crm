import { apiClient } from "~/lib/api-client";
import type { CreateGroupRequest, WhatsAppGroupDetail, WhatsAppGroupSummary, WhatsAppGroupsResponse } from "~/types/api";

/** WhatsApp groups (`/inbox/groups`): their chats are inbox conversations. */
export const groupsService = {
  list: () => apiClient.get<WhatsAppGroupsResponse>("/inbox/groups").then((r) => r.data),
  get: (id: string) => apiClient.get<WhatsAppGroupDetail>(`/inbox/groups/${id}`).then((r) => r.data),
  create: (body: CreateGroupRequest) => apiClient.post<WhatsAppGroupSummary>("/inbox/groups", body).then((r) => r.data),
  refresh: (id: string) => apiClient.post<WhatsAppGroupDetail>(`/inbox/groups/${id}/refresh`).then((r) => r.data),
  update: (id: string, body: { subject?: string; description?: string }) => apiClient.patch<WhatsAppGroupDetail>(`/inbox/groups/${id}`, body).then((r) => r.data),
  resetLink: (id: string) => apiClient.post<WhatsAppGroupDetail>(`/inbox/groups/${id}/invite-link`).then((r) => r.data),
  removeParticipant: (id: string, waId: string) => apiClient.delete<WhatsAppGroupDetail>(`/inbox/groups/${id}/participants/${encodeURIComponent(waId)}`).then((r) => r.data),
  decide: (id: string, requestId: string, approve: boolean) =>
    apiClient.post<WhatsAppGroupDetail>(`/inbox/groups/${id}/join-requests/${requestId}/${approve ? "approve" : "reject"}`).then((r) => r.data),
  remove: (id: string) => apiClient.delete<WhatsAppGroupSummary>(`/inbox/groups/${id}`).then((r) => r.data),
  qr: (id: string, format: "svg" | "png") => apiClient.get<Blob>(`/inbox/groups/${id}/qr`, { params: { format }, responseType: "blob" }).then((r) => r.data),
};
