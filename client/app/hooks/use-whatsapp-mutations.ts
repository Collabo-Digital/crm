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
 * Step 2 of WhatsApp Embedded Signup: forward the short-lived code returned by
 * the Meta popup to the backend so it can exchange it for an access token,
 * fetch the WABA + phone number, and create the Channel row.
 */
export function useCompleteWhatsAppInstallMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: WhatsAppCallbackRequest) => channelService.completeWhatsAppInstall(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      toast.success("WhatsApp Business connected!");
    },
    onError: (error) => handleMutationError(error, "Failed to connect WhatsApp Business."),
  });
}
