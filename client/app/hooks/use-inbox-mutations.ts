import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { customerKeys } from "~/hooks/use-customer-queries";
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
 * Keys for sends the server has not answered yet, by what was sent. If the
 * answer was lost (a dropped connection, a timeout) the message may already
 * be on its way, so sending the same thing again reuses the key and the
 * server sends it once. A changed message gets a new key.
 */
function useUnansweredKeys() {
  const keys = useRef(new Map<string, string>());
  return {
    keyFor: (what: unknown) => {
      const fingerprint = JSON.stringify(what);
      const key = keys.current.get(fingerprint) ?? nextClientId();
      keys.current.set(fingerprint, key);
      return key;
    },
    answered: (what: unknown) => keys.current.delete(JSON.stringify(what)),
  };
}

/**
 * Send from the composer. A refusal (window closed, opted out…) is not an
 * HTTP error: it comes back as `{ ok: false, message }` and is shown as is.
 */
export function useSendMessageMutation(conversationId: string) {
  const queryClient = useQueryClient();
  const unanswered = useUnansweredKeys();
  return useMutation({
    mutationFn: (data: { payload: InboxSendPayload; replyToMessageId?: string }) =>
      inboxService.send(conversationId, { ...data, clientId: unanswered.keyFor([conversationId, data]) }),
    onSuccess: (outcome, data) => {
      unanswered.answered([conversationId, data]);
      if (!outcome.ok) toast.error(outcome.message);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
    },
    onError: (error) => handleMutationError(error, "The message was not sent."),
  });
}

/** Start a WhatsApp chat with a number, or add it as a contact. */
export function useStartChatMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: inboxService.startChat,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.contacts() });
    },
    onError: (error) => handleMutationError(error, "The chat could not be started."),
  });
}

/** Send a failed message again. A refusal comes back as `{ ok: false, message }`, like a send. */
export function useResendMessageMutation(conversationId: string) {
  const queryClient = useQueryClient();
  const unanswered = useUnansweredKeys();
  return useMutation({
    mutationFn: (messageId: string) => inboxService.resend(conversationId, messageId, unanswered.keyFor([conversationId, messageId])),
    onSuccess: (outcome, messageId) => {
      unanswered.answered([conversationId, messageId]);
      if (!outcome.ok) toast.error(outcome.message);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
    },
    onError: (error) => handleMutationError(error, "The message was not sent again."),
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

/** Voice notes on their way, by conversation; the thread shows each one while it is pending. */
export const voiceNoteKey = (conversationId: string) => [...inboxKeys.all, "voice-note", conversationId] as const;

export interface VoiceNoteSend {
  file: File;
  durationMs: number;
  replyToMessageId?: string;
}

/**
 * Upload a recording and send it as a voice note. One mutation for both steps
 * so the thread can show the note from the moment Send is pressed; it settles
 * only once the thread has refetched, so the pending note hands over to the
 * real message without a gap.
 */
export function useSendVoiceNoteMutation(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: voiceNoteKey(conversationId),
    mutationFn: async ({ file, replyToMessageId }: VoiceNoteSend) => {
      const upload = await inboxService.upload(file, { voice: true });
      const payload: InboxSendPayload = { type: "media", mediaKind: "audio", storageKey: upload.storageKey, mime: upload.mime, voice: true };
      return inboxService.send(conversationId, { payload, replyToMessageId, clientId: nextClientId() });
    },
    onSuccess: (outcome) => {
      if (!outcome.ok) toast.error(outcome.message);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
      return queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) });
    },
    onError: (error) => handleMutationError(error, "The voice note was not sent."),
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

/** Another chat is the same person. The linked customer shows on both chats and on the customer's page. */
export function useSamePersonMutation(contactId: string) {
  const invalidate = useInvalidateContact();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (otherContactId: string) => inboxService.samePerson(contactId, otherContactId),
    onSuccess: (contact) => {
      toast.success(contact.customer?.name ? `Both chats are now linked to ${contact.customer.name}.` : "Both chats are now linked to one customer.");
      invalidate();
      void queryClient.invalidateQueries({ queryKey: customerKeys.all });
    },
    onError: (error) => handleMutationError(error, "The chats were not linked."),
  });
}

export function useRecordConsentMutation(contactId: string) {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: (data: { type: "OPT_IN" | "OPT_OUT"; note?: string }) =>
      inboxService.recordConsent(contactId, data),
    onSuccess: (_data, { type }) => {
      toast.success(type === "OPT_IN" ? "Marked as opted in." : "Marked as opted out.");
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
