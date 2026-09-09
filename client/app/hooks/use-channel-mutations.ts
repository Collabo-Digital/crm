import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { channelService } from "~/services/channel.service";
import { channelKeys } from "~/hooks/use-channel-queries";
import { orgKeys } from "~/hooks/use-org-queries";
import { handleMutationError } from "~/lib/handle-mutation-error";
import type { UpdateChannelRequest, TriggerSyncRequest, ShopifyInstallRequest, ManualConnectShopifyRequest, UpdateSyncSettingsRequest, InstagramInstallRequest, CompleteInstagramRequest } from "~/types/api";

/** Mutation hook for updating a channel's settings. */
export function useUpdateChannelMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateChannelRequest }) =>
      channelService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      toast.success("Channel updated.");
    },
    onError: (error) => handleMutationError(error, "Failed to update channel."),
  });
}

/** Mutation hook for disconnecting a channel. */
export function useDisconnectChannelMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => channelService.disconnect(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      toast.success("Channel disconnected.");
    },
    onError: (error) => handleMutationError(error, "Failed to disconnect channel."),
  });
}

/** Mutation hook for triggering a manual sync on a channel. */
export function useTriggerSyncMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: TriggerSyncRequest }) =>
      channelService.triggerSync(id, data),
    onSuccess: (_, variables) => {
      // The channels page renders channelKeys.list(); invalidating only the
      // detail key meant the row never refreshed after a sync was triggered.
      queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      queryClient.invalidateQueries({ queryKey: channelKeys.detail(variables.id) });
      toast.success("Sync started.");
    },
    onError: (error) => handleMutationError(error, "Failed to start sync."),
  });
}

/** Mutation hook for saving a channel's per-entity sync toggles. */
export function useUpdateSyncSettingsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateSyncSettingsRequest }) =>
      channelService.updateSyncSettings(id, data),
    // The PATCH returns the freshly-resolved settings, so seed the cache with
    // them rather than invalidating and making the menu flicker mid-interaction.
    onSuccess: (settings, variables) => {
      queryClient.setQueryData(channelKeys.syncSettings(variables.id), settings);
    },
    onError: (error) => handleMutationError(error, "Failed to save sync settings."),
  });
}

/** Mutation hook for starting Shopify OAuth flow. Redirects to Shopify on success. */
export function useInstallShopifyMutation() {
  return useMutation({
    mutationFn: (data: ShopifyInstallRequest) => channelService.installShopify(data),
    onSuccess: (response) => {
      window.location.href = response.authUrl;
    },
    onError: (error) => handleMutationError(error, "Failed to start Shopify connection."),
  });
}

/** Mutation hook for manually connecting a Shopify store with custom app credentials. */
export function useManualConnectShopifyMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: ManualConnectShopifyRequest) => channelService.manualConnectShopify(data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      // Org currency is auto-synced from the Shopify shop on connect — refresh org queries so the UI picks it up.
      queryClient.invalidateQueries({ queryKey: orgKeys.all });
      toast.success(`Shopify store "${response.shopName}" connected!`);
    },
    onError: (error) => handleMutationError(error, "Failed to connect Shopify store."),
  });
}

/**
 * Start the Instagram (Facebook Login) flow. Redirects to Meta on success.
 *
 * Pass `reconnectChannelId` to re-authorize an existing account instead of
 * adding another — an org may hold many Instagram accounts, so the two are
 * genuinely different intents.
 */
export function useInstallInstagramMutation() {
  return useMutation({
    mutationFn: (data: InstagramInstallRequest = {}) => channelService.installInstagram(data),
    onSuccess: (response) => {
      window.location.href = response.authUrl;
    },
    onError: (error) => handleMutationError(error, "Failed to start Instagram connection."),
  });
}

/**
 * Connect the Instagram account the merchant chose, when one Facebook login
 * granted several.
 */
export function useCompleteInstagramInstallMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CompleteInstagramRequest) => channelService.completeInstagramInstall(data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      toast.success(
        response.account?.handle
          ? `Instagram ${response.account.handle} connected.`
          : "Instagram account connected.",
      );
    },
    onError: (error) => handleMutationError(error, "Failed to connect that Instagram account."),
  });
}
