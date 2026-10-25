import { useEffect, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { customerKeys } from "~/hooks/use-customer-queries";
import { dashboardKeys } from "~/hooks/use-dashboard-queries";
import { inventoryKeys } from "~/hooks/use-inventory-queries";
import { orderKeys } from "~/hooks/use-order-queries";
import { productKeys } from "~/hooks/use-product-queries";
import { isActiveChannel } from "~/lib/channel-providers";
import { pollWhile } from "~/lib/poll-while";
import { channelService } from "~/services/channel.service";
import type { Channel, ShopifyLocationsResponse } from "~/types/api";

/** React Query key factory for all channel-related queries. */
export const channelKeys = {
  all: ["channels"] as const,
  list: () => [...channelKeys.all, "list"] as const,
  detail: (id: string) => [...channelKeys.all, "detail", id] as const,
  syncSettings: (id: string) => [...channelKeys.all, "sync-settings", id] as const,
  instagramPending: (id: string) => [...channelKeys.all, "instagram-pending", id] as const,
  shopifyLocations: (id: string) => [...channelKeys.all, "shopify-locations", id] as const,
};

// Poll only while something is actually syncing, and stop by itself once it
// settles. IN_PROGRESS covers "queued or running": the server claims the
// channel when the sync is triggered, so the refetch after a trigger already
// sees it.
const pollWhileAnyChannelSyncing = pollWhile<Channel[]>(
  (channels) => channels?.some((c) => c.syncStatus === "IN_PROGRESS") ?? false,
);

/** Fetch all connected channels for the current organization. */
export function useChannels() {
  return useQuery({
    queryKey: channelKeys.list(),
    queryFn: () => channelService.list(),
    refetchInterval: pollWhileAnyChannelSyncing,
  });
}

/**
 * When a channel's sync finishes, refresh what it changed: the gear menu's
 * "not synced yet" / "pending" labels, and the data the sync pulled in.
 *
 * A finish is IN_PROGRESS → anything else, or a new lastSyncedAt (a sync
 * short enough to start and end between two polls).
 */
export function useRefreshAfterChannelSync(channels: Channel[] | undefined) {
  const queryClient = useQueryClient();
  const seen = useRef(
    new Map<string, { status: string; syncedAt: string | null }>(),
  );

  useEffect(() => {
    if (!channels) return;

    for (const channel of channels) {
      const before = seen.current.get(channel.id);
      const now = { status: channel.syncStatus, syncedAt: channel.lastSyncedAt };
      seen.current.set(channel.id, now);
      if (!before) continue; // first sight of this channel — nothing finished

      const finished =
        (before.status === "IN_PROGRESS" && now.status !== "IN_PROGRESS") ||
        before.syncedAt !== now.syncedAt;
      if (!finished) continue;

      void queryClient.invalidateQueries({
        queryKey: channelKeys.syncSettings(channel.id),
      });
      // A sync can find Shopify locations nobody has decided about yet.
      void queryClient.invalidateQueries({
        queryKey: channelKeys.shopifyLocations(channel.id),
      });
      for (const queryKey of [
        productKeys.all,
        orderKeys.all,
        customerKeys.all,
        inventoryKeys.all,
        dashboardKeys.all,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }
  }, [channels, queryClient]);
}

/** Per-entity sync toggles + state for one channel. */
export function useSyncSettings(id?: string | null) {
  return useQuery({
    queryKey: channelKeys.syncSettings(id!),
    queryFn: () => channelService.getSyncSettings(id!),
    enabled: !!id,
  });
}

/**
 * The Instagram accounts one Facebook login granted, for the picker.
 *
 * Never retried: the only failure that matters is a 404 from an expired or
 * already-used selection, and retrying that just delays telling the merchant to
 * start again. Held in cache indefinitely because the underlying Redis entry is
 * single-use — a refetch after the pick would 404 against a dialog that already
 * succeeded.
 */
export function useInstagramPending(pendingId?: string | null) {
  return useQuery({
    queryKey: channelKeys.instagramPending(pendingId!),
    queryFn: () => channelService.getInstagramPending(pendingId!),
    enabled: !!pendingId,
    retry: false,
    staleTime: Infinity,
  });
}

/** Fetch a single channel by ID with sync logs. */
export function useChannel(id?: string | null) {
  return useQuery({
    queryKey: channelKeys.detail(id!),
    queryFn: () => channelService.get(id!),
    enabled: !!id,
  });
}

// Right after connecting, the store's locations may not have been read from
// Shopify yet: the list comes back empty while still pending.
const pollWhileShopifyLocationsUnread = pollWhile<ShopifyLocationsResponse>(
  (data) => data?.status === "PENDING" && data.locations.length === 0,
);

function shopifyLocationsQuery(channelId: string) {
  return {
    queryKey: channelKeys.shopifyLocations(channelId),
    queryFn: () => channelService.getShopifyLocations(channelId),
    refetchInterval: pollWhileShopifyLocationsUnread,
  };
}

/** One store's Shopify locations and what each one does in Collabo. */
export function useShopifyLocations(channelId?: string | null) {
  return useQuery({ ...shopifyLocationsQuery(channelId!), enabled: !!channelId });
}

/**
 * The connected Shopify stores with a location still waiting for a decision.
 * A refused or failed read counts as nothing pending, so the prompt never
 * shows for someone who could not act on it.
 */
export function usePendingShopifyLocations(): Channel[] {
  const channels = useChannels();
  const stores = (channels.data ?? []).filter(
    (c) => c.platform === "SHOPIFY" && isActiveChannel(c),
  );
  const results = useQueries({ queries: stores.map((c) => shopifyLocationsQuery(c.id)) });
  return stores.filter((_, i) => results[i]?.data?.status === "PENDING");
}
