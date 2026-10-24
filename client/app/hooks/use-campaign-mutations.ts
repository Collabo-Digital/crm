import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { campaignKeys } from "~/hooks/use-campaign-queries";
import { inboxKeys } from "~/hooks/use-inbox-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { campaignsService, type SaveBroadcastRequest } from "~/services/campaigns.service";
import type { BroadcastDetail, ContactImportMapping, MessageRate, SegmentDefinition, TemplateDraft, WriteTemplateRequest } from "~/types/api";

export function useSyncTemplatesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => campaignsService.syncTemplates(),
    onSuccess: (result) => {
      toast.success(`${result.synced} template${result.synced === 1 ? "" : "s"} synced from WhatsApp.`);
      void queryClient.invalidateQueries({ queryKey: campaignKeys.templates() });
      void queryClient.invalidateQueries({ queryKey: campaignKeys.overview() });
    },
    onError: (error) => handleMutationError(error, "Templates could not be synced."),
  });
}

/** Create (no id) or edit (id) a template. Either way it goes to Meta for review. */
export function useSaveTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draft, starterKey }: { id?: string; draft: TemplateDraft; starterKey?: string }) =>
      id ? campaignsService.updateTemplate(id, draft) : campaignsService.createTemplate(draft, starterKey),
    onSuccess: (template) => {
      toast.success(`${template.name} sent to Meta for review.`);
      void queryClient.invalidateQueries({ queryKey: campaignKeys.templates() });
    },
    onError: (error) => handleMutationError(error, "The template was not submitted."),
  });
}

/** A template draft written by AI; the editor opens with it. */
export function useWriteTemplateMutation() {
  return useMutation({
    mutationFn: (body: WriteTemplateRequest) => campaignsService.writeTemplate(body),
    onError: (error) => handleMutationError(error, "The AI could not write a draft."),
  });
}

export function useDeleteTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => campaignsService.deleteTemplate(id),
    onSuccess: () => {
      toast.success("Template deleted at Meta.");
      void queryClient.invalidateQueries({ queryKey: campaignKeys.templates() });
    },
    onError: (error) => handleMutationError(error, "The template was not deleted."),
  });
}

export function useCampaignUploadMutation() {
  return useMutation({
    mutationFn: (file: File) => campaignsService.upload(file),
    onError: (error) => handleMutationError(error, "The file was not uploaded."),
  });
}

export function useSaveSegmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id?: string; name: string; description?: string | null; definition: SegmentDefinition }) =>
      id ? campaignsService.updateSegment(id, data) : campaignsService.createSegment(data),
    onSuccess: (segment) => {
      toast.success(`${segment.name} saved · ${segment.lastCount?.toLocaleString("en-IN") ?? 0} contacts.`);
      void queryClient.invalidateQueries({ queryKey: campaignKeys.segments() });
    },
    onError: (error) => handleMutationError(error, "The segment was not saved."),
  });
}

export function useDeleteSegmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => campaignsService.deleteSegment(id),
    onSuccess: () => {
      toast.success("Segment deleted.");
      void queryClient.invalidateQueries({ queryKey: campaignKeys.segments() });
    },
    onError: (error) => handleMutationError(error, "The segment was not deleted."),
  });
}

function useInvalidateBroadcasts() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: campaignKeys.broadcasts() });
    void queryClient.invalidateQueries({ queryKey: campaignKeys.overview() });
    if (id) void queryClient.invalidateQueries({ queryKey: campaignKeys.broadcast(id) });
  };
}

export function useCreateBroadcastMutation() {
  const invalidate = useInvalidateBroadcasts();
  return useMutation({
    mutationFn: (data: SaveBroadcastRequest) => campaignsService.createBroadcast(data),
    onSuccess: () => invalidate(),
    onError: (error) => handleMutationError(error, "The broadcast was not created."),
  });
}

/**
 * Saves the draft quietly as the composer changes; only failures speak up.
 * `save` builds each change from the draft as it stands, shows it at once,
 * and sends the saves one at a time in order, so a change made before the
 * last one is saved builds on it instead of overwriting it.
 */
export function useUpdateBroadcastMutation(id: string) {
  const queryClient = useQueryClient();
  const key = campaignKeys.broadcast(id);
  const mutationKey = ["broadcast-save", id];
  const mutation = useMutation({
    mutationKey,
    scope: { id: `broadcast-save:${id}` },
    mutationFn: (data: SaveBroadcastRequest) => campaignsService.updateBroadcast(id, data),
    onSuccess: (broadcast) => {
      // A later save is still queued: its answer includes this one, and showing this one would undo it on screen.
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      queryClient.setQueryData(key, broadcast);
      void queryClient.invalidateQueries({ queryKey: campaignKeys.broadcastPreview(id) });
    },
    onError: (error) => {
      handleMutationError(error, "Your changes were not saved.");
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const save = (change: (draft: BroadcastDetail) => SaveBroadcastRequest) => {
    const draft = queryClient.getQueryData<BroadcastDetail>(key);
    if (!draft) return;
    const data = change(draft);
    void queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<BroadcastDetail>(key, { ...draft, ...data });
    mutation.mutate(data);
  };
  return { save, isPending: mutation.isPending };
}

export function useDeleteBroadcastMutation() {
  const invalidate = useInvalidateBroadcasts();
  return useMutation({
    mutationFn: (id: string) => campaignsService.deleteBroadcast(id),
    onSuccess: () => {
      toast.success("Draft deleted.");
      invalidate();
    },
    onError: (error) => handleMutationError(error, "The draft was not deleted."),
  });
}

export function useDuplicateBroadcastMutation() {
  const invalidate = useInvalidateBroadcasts();
  return useMutation({
    mutationFn: (id: string) => campaignsService.duplicateBroadcast(id),
    onSuccess: () => invalidate(),
    onError: (error) => handleMutationError(error, "The broadcast was not duplicated."),
  });
}

export function useTestBroadcastMutation(id: string) {
  return useMutation({
    mutationFn: (phone: string) => campaignsService.testBroadcast(id, phone),
    onSuccess: (outcome) => {
      if (outcome.ok) toast.success("Test sent. Check the phone.");
      else toast.error(outcome.message);
    },
    onError: (error) => handleMutationError(error, "The test was not sent."),
  });
}

export function useSendBroadcastMutation(id: string) {
  const invalidate = useInvalidateBroadcasts();
  return useMutation({
    mutationFn: (scheduledAt?: string) => campaignsService.sendBroadcast(id, scheduledAt),
    onSuccess: (broadcast) => {
      toast.success(broadcast.status === "SCHEDULED" && broadcast.scheduledAt && new Date(broadcast.scheduledAt).getTime() > Date.now() + 30_000 ? "Broadcast scheduled." : "Broadcast is sending.");
      invalidate(id);
    },
    onError: (error) => handleMutationError(error, "The broadcast was not sent."),
  });
}

export function useCancelBroadcastMutation(id: string) {
  const invalidate = useInvalidateBroadcasts();
  return useMutation({
    mutationFn: () => campaignsService.cancelBroadcast(id),
    onSuccess: (broadcast) => {
      toast.success(broadcast.status === "DRAFT" ? "Schedule cancelled. It is a draft again." : "Sending stopped.");
      invalidate(id);
    },
    onError: (error) => handleMutationError(error, "The broadcast was not cancelled."),
  });
}

export function useRetryBroadcastMutation(id: string) {
  const invalidate = useInvalidateBroadcasts();
  return useMutation({
    mutationFn: () => campaignsService.retryBroadcast(id),
    onSuccess: (result) => {
      toast.success(
        `Retrying ${result.retrying} message${result.retrying === 1 ? "" : "s"}` +
          (result.notRetryable ? ` · ${result.notRetryable} failed for reasons a retry would repeat` : "."),
      );
      invalidate(id);
    },
    onError: (error) => handleMutationError(error, "Nothing was retried."),
  });
}

export function useReplaceRatesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rows: MessageRate[]) => campaignsService.replaceRates(rows),
    onSuccess: () => {
      toast.success("Message rates saved.");
      void queryClient.invalidateQueries({ queryKey: campaignKeys.rates() });
      void queryClient.invalidateQueries({ queryKey: [...campaignKeys.broadcasts(), "preview"] });
    },
    onError: (error) => handleMutationError(error, "The rates were not saved."),
  });
}

export function useContactImportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      mapping,
      options,
    }: {
      file: File;
      mapping: ContactImportMapping;
      options: { defaultCountryCode?: string; tags?: string[]; markOptedIn?: boolean };
    }) => campaignsService.runImport(file, mapping, options),
    onSuccess: (result) => {
      toast.success(`${result.created} added, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""}.`);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.contacts() });
    },
    onError: (error) => handleMutationError(error, "The contacts were not imported."),
  });
}
