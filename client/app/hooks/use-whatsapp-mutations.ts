import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { channelService } from "~/services/channel.service";
import { channelKeys } from "~/hooks/use-channel-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import type { WhatsAppCallbackRequest, WhatsAppInstallRequest } from "~/types/api";

/**
 * Step 1 of WhatsApp Embedded Signup: ask the backend for the `configId` and
 * CSRF `state` token to feed into the Meta JS SDK's FB.login popup.
 */
export function useWhatsAppInstallMutation() {
  return useMutation({
    mutationFn: (data: WhatsAppInstallRequest = {}) => channelService.installWhatsApp(data),
    onError: (error) => handleMutationError(error, "Failed to start WhatsApp connection."),
  });
}

/**
 * Step 2 of WhatsApp Embedded Signup: forward the code and session info the
 * Meta popup returned so the backend can exchange it, subscribe to the
 * number's webhooks and create the Channel row.
 */
export function useCompleteWhatsAppInstallMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: WhatsAppCallbackRequest) => channelService.completeWhatsAppInstall(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      const incomplete = result.setup.webhooks === "failed" || result.setup.registration === "failed";
      if (incomplete) {
        toast.warning("WhatsApp connected, but setup is incomplete. Open the channel to retry.");
      } else if (result.isOnBizApp) {
        toast.success(
          "WhatsApp Business app number connected. Importing up to six months of chats — keep the app open on the phone.",
        );
      } else {
        toast.success("WhatsApp Business connected!");
      }
    },
    onError: (error) => handleMutationError(error, "Failed to connect WhatsApp Business."),
  });
}

export function useRetryWhatsAppSetupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => channelService.retryWhatsAppSetup(channelId),
    onSuccess: (outcome) => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      if (outcome.webhooks === "failed" || outcome.registration === "failed") {
        toast.error(outcome.webhooksError ?? outcome.registrationError ?? "Setup still failed. Check the number in WhatsApp Manager.");
      } else {
        toast.success("WhatsApp setup completed.");
      }
    },
    onError: (error) => handleMutationError(error, "Could not retry WhatsApp setup."),
  });
}

export function useRefreshWhatsAppHealthMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => channelService.refreshWhatsAppHealth(channelId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: channelKeys.all }),
    onError: (error) => handleMutationError(error, "Could not refresh the number's status."),
  });
}
