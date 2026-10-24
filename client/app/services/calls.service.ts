import { apiClient } from "~/lib/api-client";
import type { CallPermission, CallSettings, InboxSendOutcome, WhatsAppCallDetail, WhatsAppCallView } from "~/types/api";

/** WhatsApp calls in the browser: the signalling around the WebRTC connection. */
export const callsService = {
  live: () => apiClient.get<WhatsAppCallView[]>("/inbox/calls/live").then((r) => r.data),
  get: (id: string) => apiClient.get<WhatsAppCallDetail>(`/inbox/calls/${id}`).then((r) => r.data),
  accept: (id: string, sdp: string) => apiClient.post<WhatsAppCallView>(`/inbox/calls/${id}/accept`, { sdp }, { timeout: 60_000 }).then((r) => r.data),
  reject: (id: string) => apiClient.post(`/inbox/calls/${id}/reject`).then((r) => r.data),
  terminate: (id: string) => apiClient.post(`/inbox/calls/${id}/terminate`).then((r) => r.data),
  permission: (conversationId: string) => apiClient.get<CallPermission>(`/inbox/conversations/${conversationId}/call-permission`).then((r) => r.data),
  askPermission: (conversationId: string, text?: string) =>
    apiClient.post<InboxSendOutcome>(`/inbox/conversations/${conversationId}/call-permission`, text ? { text } : {}).then((r) => r.data),
  start: (conversationId: string, sdp: string) =>
    apiClient.post<WhatsAppCallView>(`/inbox/conversations/${conversationId}/calls`, { sdp }, { timeout: 60_000 }).then((r) => r.data),
  settings: (channelId: string) => apiClient.get<CallSettings>(`/inbox/calls/settings/${channelId}`).then((r) => r.data),
  saveSettings: (channelId: string, body: { enabled: boolean; showCallButton: boolean; callbackPermission: boolean }) =>
    apiClient.put<CallSettings>(`/inbox/calls/settings/${channelId}`, body).then((r) => r.data),
};
