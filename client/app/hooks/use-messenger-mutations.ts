import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { channelService } from "~/services/channel.service";
import { channelKeys } from "~/hooks/use-channel-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import type { MessengerCallbackRequest } from "~/types/api";

/** Step 1: config id + state for the Facebook Login for Business popup. */
export function useMessengerInstallMutation() {
  return useMutation({
    mutationFn: () => channelService.installMessenger(),
    onError: (error) => handleMutationError(error, "Failed to start the Facebook connection."),
  });
}

/** Step 2: connect every Page the business shared, plus their Instagram accounts. */
export function useCompleteMessengerInstallMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: MessengerCallbackRequest) => channelService.completeMessengerInstall(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      const pages = result.connected.filter((c) => c.platform === "FACEBOOK").length;
      const instagram = result.connected.filter((c) => c.platform === "INSTAGRAM").length;
      const parts = [
        pages ? `${pages} Facebook Page${pages === 1 ? "" : "s"}` : null,
        instagram ? `${instagram} Instagram account${instagram === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      if (parts.length) toast.success(`Connected ${parts.join(" and ")}.`);
      for (const skipped of result.skipped) toast.warning(`${skipped.name}: ${skipped.reason}`);
      if (result.connected.some((c) => c.webhooks === "failed")) {
        toast.warning("Some accounts could not be subscribed to messages. Open them to see why.");
      }
    },
    onError: (error) => handleMutationError(error, "Failed to connect Facebook."),
  });
}
