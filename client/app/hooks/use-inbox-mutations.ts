import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { inboxKeys } from "~/hooks/use-inbox-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { inboxService } from "~/services/inbox.service";
import type {
  InboxAvailability,
  InboxBulkRequest,
  InboxSendPayload,
  SaveInboxViewRequest,
  SaveQuickReplyRequest,
  UpdateInboxContactRequest,
} from "~/types/api";

let clientSeq = 0;
/** A per-send key: a retried request with the same key sends once. */
export const nextClientId = () => `${Date.now().toString(36)}-${(clientSeq++).toString(36)}`;

/**
 * Send from the composer. A refusal (window closed, opted out…) is not an
 * HTTP error: it comes back as `{ ok: false, message }` and is shown as is.
 */
export function useSendMessageMutation(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { payload: InboxSendPayload; replyToMessageId?: string }) =>
      inboxService.send(conversationId, { ...data, clientId: nextClientId() }),
    onSuccess: (outcome) => {
      if (!outcome.ok) toast.error(outcome.message);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
    },
    onError: (error) => handleMutationError(error, "The message was not sent."),
  });
}

export function useMarkReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => inboxService.markRead(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(id) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.counts() });
    },
  });
}

/** Assign, move team, snooze, close or reopen one conversation. */
export function useUpdateConversationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      status?: "OPEN" | "CLOSED" | "SNOOZED";
      snoozedUntil?: string;
      assignedUserId?: string | null;
      teamId?: string | null;
      /** Toast text on success. */
      done?: string;
    }) => {
      const { done: _done, ...body } = data;
      return inboxService.updateConversation(id, body);
    },
    onSuccess: (_result, { id, done }) => {
      if (done) toast.success(done);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(id) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.counts() });
    },
    onError: (error) => handleMutationError(error, "The conversation was not updated."),
  });
}

export function useBulkConversationsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: InboxBulkRequest) => inboxService.bulk(data),
    onSuccess: (result) => {
      const skipped = result.skipped.length;
      toast.success(
        `${result.updated} conversation${result.updated === 1 ? "" : "s"} updated` +
          (skipped ? ` · ${skipped} skipped: ${result.skipped[0].reason}` : ""),
      );
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    },
    onError: (error) => handleMutationError(error, "Nothing was changed."),
  });
}

export function useAddNoteMutation(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => inboxService.addNote(conversationId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) });
    },
    onError: (error) => handleMutationError(error, "The note was not saved."),
  });
}

export function useUploadMutation() {
  return useMutation({
    mutationFn: (file: File) => inboxService.upload(file),
    onError: (error) => handleMutationError(error, "The file was not uploaded."),
  });
}

// ─── Contacts ────────────────────────────────────────────────────────────

/** Contact edits show in the panel, the list rows (tags) and the contacts page. */
function useInvalidateContact() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: inboxKeys.contacts() });
    void queryClient.invalidateQueries({ queryKey: [...inboxKeys.all, "conversation"] });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
  };
}

export function useUpdateContactMutation(contactId: string) {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: (data: UpdateInboxContactRequest & { done?: string }) => {
      const { done: _done, ...body } = data;
      return inboxService.updateContact(contactId, body);
    },
    onSuccess: (_data, { done }) => {
      if (done) toast.success(done);
      invalidate();
    },
    onError: (error) => handleMutationError(error, "The contact was not updated."),
  });
}

export function useRecordConsentMutation(contactId: string) {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: (data: { type: "OPT_IN" | "OPT_OUT"; note?: string }) =>
      inboxService.recordConsent(contactId, data),
    onSuccess: (_data, { type }) => {
      toast.success(type === "OPT_IN" ? "Marked as subscribed." : "Marked as opted out.");
      invalidate();
    },
    onError: (error) => handleMutationError(error, "Consent was not recorded."),
  });
}

export function useBulkTagContactsMutation() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: (data: { ids: string[]; add?: string[]; remove?: string[] }) =>
      inboxService.bulkTagContacts(data),
    onSuccess: (result) => {
      toast.success(`${result.updated} contact${result.updated === 1 ? "" : "s"} updated.`);
      invalidate();
    },
    onError: (error) => handleMutationError(error, "Tags were not changed."),
  });
}

// ─── Team and workspace ──────────────────────────────────────────────────

export function useSetAvailabilityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: InboxAvailability) => inboxService.setAvailability(status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.me() });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.members() });
    },
    onError: (error) => handleMutationError(error, "Your status was not changed."),
  });
}

function useInvalidateTeams() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: inboxKeys.teams() });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.members() });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.me() });
  };
}

export function useSaveTeamMutation() {
  const invalidate = useInvalidateTeams();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: string; name: string; memberIds: string[] }) =>
      id ? inboxService.updateTeam(id, data) : inboxService.createTeam(data),
    onSuccess: (team, { id }) => {
      toast.success(id ? `${team.name} saved.` : `${team.name} created.`);
      invalidate();
    },
    onError: (error) => handleMutationError(error, "The team was not saved."),
  });
}

export function useDeleteTeamMutation() {
  const invalidate = useInvalidateTeams();
  return useMutation({
    mutationFn: (id: string) => inboxService.deleteTeam(id),
    onSuccess: () => {
      toast.success("Team deleted.");
      invalidate();
    },
    onError: (error) => handleMutationError(error, "The team was not deleted."),
  });
}

export function useSaveQuickReplyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: SaveQuickReplyRequest & { id?: string }) =>
      id ? inboxService.updateQuickReply(id, data) : inboxService.createQuickReply(data),
    onSuccess: (reply, { id }) => {
      toast.success(id ? `/${reply.shortcut} saved.` : `/${reply.shortcut} created.`);
      void queryClient.invalidateQueries({ queryKey: [...inboxKeys.all, "quick-replies"] });
    },
    onError: (error) => handleMutationError(error, "The quick reply was not saved."),
  });
}

export function useDeleteQuickReplyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => inboxService.deleteQuickReply(id),
    onSuccess: () => {
      toast.success("Quick reply deleted.");
      void queryClient.invalidateQueries({ queryKey: [...inboxKeys.all, "quick-replies"] });
    },
    onError: (error) => handleMutationError(error, "The quick reply was not deleted."),
  });
}

export function useCreateViewMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SaveInboxViewRequest) => inboxService.createView(data),
    onSuccess: (view) => {
      toast.success(`View “${view.name}” saved.`);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.views() });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.counts() });
    },
    onError: (error) => handleMutationError(error, "The view was not saved."),
  });
}

export function useDeleteViewMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => inboxService.deleteView(id),
    onSuccess: () => {
      toast.success("View deleted.");
      void queryClient.invalidateQueries({ queryKey: inboxKeys.views() });
    },
    onError: (error) => handleMutationError(error, "The view was not deleted."),
  });
}
