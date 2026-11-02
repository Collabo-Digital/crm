import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { callsService } from "~/services/calls.service";

export const callKeys = {
  live: ["calls", "live"] as const,
  settings: (channelId: string) => ["calls", "settings", channelId] as const,
};

/**
 * Calls ringing or in progress for the organization. Checked every few
 * seconds on every page so a call rings anywhere in the app; the inbox's live
 * stream also asks for a check the moment a call changes.
 */
export function useLiveCalls(enabled: boolean) {
  return useQuery({
    queryKey: callKeys.live,
    queryFn: () => callsService.live(),
    enabled,
    refetchInterval: 4000,
    refetchIntervalInBackground: true,
    staleTime: 1000,
  });
}

export function useCallSettings(channelId: string, enabled: boolean) {
  return useQuery({ queryKey: callKeys.settings(channelId), queryFn: () => callsService.settings(channelId), enabled, retry: false });
}

export function useSaveCallSettings(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled: boolean; showCallButton: boolean; callbackPermission: boolean }) => callsService.saveSettings(channelId, body),
    onSuccess: (data) => {
      queryClient.setQueryData(callKeys.settings(channelId), data);
      toast.success("Calling settings saved. WhatsApp can take a while to show the change on people's phones.");
    },
    onError: (error) => handleMutationError(error, "The calling settings were not saved."),
  });
}
