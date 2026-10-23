import { apiClient } from "~/lib/api-client";
import type {
  DraftFromCart,
  StoreProductsResponse,
  InboxAvailability,
  InboxBulkRequest,
  InboxBulkResult,
  InboxContactDetail,
  InboxContactQuery,
  InboxContactRow,
  InboxConversationDetail,
  InboxConversationPage,
  InboxCounts,
  InboxCursor,
  InboxCustomerMatch,
  InboxFilters,
  InboxMe,
  InboxMember,
  InboxMessagePage,
  InboxNote,
  InboxSavedView,
  InboxSendOutcome,
  InboxSendPayload,
  InboxTeam,
  InboxUpload,
  PaginatedResponse,
  QuickReply,
  SaveInboxViewRequest,
  SaveQuickReplyRequest,
  UpdateInboxContactRequest,
} from "~/types/api";

/** Booleans travel as "true" in a query string; absent means "not filtered". */
function filterParams(filters: InboxFilters) {
  const { unread, comments, search, ...rest } = filters;
  return {
    ...rest,
    ...(unread ? { unread: "true" } : {}),
    ...(comments ? { comments: "true" } : {}),
    ...(search?.trim() ? { search: search.trim() } : {}),
  };
}

/**
 * Service layer for the shared inbox (`/inbox/*`).
 *
 * Each method returns the unwrapped response data (the API client already
 * strips the `{ success, data }` envelope).
 */
export const inboxService = {
  listConversations: (filters: InboxFilters, cursor?: InboxCursor | null) =>
    apiClient
      .get<InboxConversationPage>("/inbox/conversations", {
        params: { ...filterParams(filters), ...(cursor ?? {}) },
      })
      .then((response) => response.data),

  counts: () => apiClient.get<InboxCounts>("/inbox/counts").then((response) => response.data),

  getConversation: (id: string) =>
    apiClient.get<InboxConversationDetail>(`/inbox/conversations/${id}`).then((response) => response.data),

  listMessages: (id: string, cursor?: InboxCursor | null) =>
    apiClient
      .get<InboxMessagePage>(`/inbox/conversations/${id}/messages`, { params: cursor ?? {} })
      .then((response) => response.data),

  send: (id: string, data: { payload: InboxSendPayload; replyToMessageId?: string; clientId?: string }) =>
    apiClient.post<InboxSendOutcome>(`/inbox/conversations/${id}/messages`, data).then((response) => response.data),

  products: (id: string, search?: string) =>
    apiClient.get<StoreProductsResponse>(`/inbox/conversations/${id}/products`, { params: search ? { search } : {} }).then((response) => response.data),
  draftFromCart: (id: string, messageId: string) =>
    apiClient.post<DraftFromCart>(`/inbox/conversations/${id}/messages/${messageId}/draft-order`).then((response) => response.data),
  markRead: (id: string) =>
    apiClient.post<{ unreadCount: number }>(`/inbox/conversations/${id}/read`).then((response) => response.data),

  /** Returns the conversation, or `{ visible: false }` when the change took it out of the member's view. */
  updateConversation: (
    id: string,
    data: {
      status?: "OPEN" | "CLOSED" | "SNOOZED";
      snoozedUntil?: string;
      assignedUserId?: string | null;
      teamId?: string | null;
    },
  ) =>
    apiClient
      .patch<InboxConversationDetail | { id: string; visible: false }>(`/inbox/conversations/${id}`, data)
      .then((response) => response.data),

  bulk: (data: InboxBulkRequest) =>
    apiClient.post<InboxBulkResult>("/inbox/conversations/bulk", data).then((response) => response.data),

  addNote: (id: string, body: string) =>
    apiClient.post<InboxNote>(`/inbox/conversations/${id}/notes`, { body }).then((response) => response.data),

  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiClient
      .post<InboxUpload>("/inbox/uploads", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120_000,
      })
      .then((response) => response.data);
  },

  // ─── Contacts ──────────────────────────────────────────────────────

  listContacts: (query: InboxContactQuery) =>
    apiClient
      .get<PaginatedResponse<InboxContactRow>>("/inbox/contacts", { params: query })
      .then((response) => response.data),

  contactTags: () =>
    apiClient.get<Array<{ tag: string; count: number }>>("/inbox/contacts/tags").then((response) => response.data),

  getContact: (id: string) =>
    apiClient.get<InboxContactDetail>(`/inbox/contacts/${id}`).then((response) => response.data),

  updateContact: (id: string, data: UpdateInboxContactRequest) =>
    apiClient.patch<InboxContactDetail>(`/inbox/contacts/${id}`, data).then((response) => response.data),

  recordConsent: (id: string, data: { type: "OPT_IN" | "OPT_OUT"; note?: string }) =>
    apiClient.post<InboxContactDetail>(`/inbox/contacts/${id}/consent`, data).then((response) => response.data),

  bulkTagContacts: (data: { ids: string[]; add?: string[]; remove?: string[] }) =>
    apiClient
      .post<{ updated: number; skipped: number }>("/inbox/contacts/bulk-tag", data)
      .then((response) => response.data),

  customerCandidates: (contactId: string, q?: string) =>
    apiClient
      .get<{ results: InboxCustomerMatch[] }>(`/inbox/contacts/${contactId}/customers`, {
        params: q ? { q } : {},
      })
      .then((response) => response.data),

  // ─── Team and workspace ────────────────────────────────────────────

  me: () => apiClient.get<InboxMe>("/inbox/me").then((response) => response.data),

  setAvailability: (status: InboxAvailability) =>
    apiClient.patch<{ status: InboxAvailability }>("/inbox/me", { status }).then((response) => response.data),

  members: () => apiClient.get<InboxMember[]>("/inbox/members").then((response) => response.data),

  listTeams: () => apiClient.get<InboxTeam[]>("/inbox/teams").then((response) => response.data),

  createTeam: (data: { name: string; memberIds: string[] }) =>
    apiClient.post<InboxTeam>("/inbox/teams", data).then((response) => response.data),

  updateTeam: (id: string, data: { name?: string; memberIds?: string[] }) =>
    apiClient.patch<InboxTeam>(`/inbox/teams/${id}`, data).then((response) => response.data),

  deleteTeam: (id: string) =>
    apiClient.delete<{ deleted: true }>(`/inbox/teams/${id}`).then((response) => response.data),

  listQuickReplies: (manage = false) =>
    apiClient
      .get<QuickReply[]>("/inbox/quick-replies", { params: manage ? { manage: "true" } : {} })
      .then((response) => response.data),

  createQuickReply: (data: SaveQuickReplyRequest) =>
    apiClient.post<QuickReply>("/inbox/quick-replies", data).then((response) => response.data),

  updateQuickReply: (id: string, data: Partial<SaveQuickReplyRequest>) =>
    apiClient.patch<QuickReply>(`/inbox/quick-replies/${id}`, data).then((response) => response.data),

  deleteQuickReply: (id: string) =>
    apiClient.delete<{ deleted: true }>(`/inbox/quick-replies/${id}`).then((response) => response.data),

  listViews: () => apiClient.get<InboxSavedView[]>("/inbox/views").then((response) => response.data),

  createView: (data: SaveInboxViewRequest) =>
    apiClient.post<InboxSavedView>("/inbox/views", data).then((response) => response.data),

  deleteView: (id: string) =>
    apiClient.delete<{ deleted: true }>(`/inbox/views/${id}`).then((response) => response.data),
};
