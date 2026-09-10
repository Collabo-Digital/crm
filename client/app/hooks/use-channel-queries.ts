import { useQuery } from "@tanstack/react-query";
import { channelService } from "~/services/channel.service";

/** React Query key factory for all channel-related queries. */
export const channelKeys = {
  all: ["channels"] as const,
  list: () => [...channelKeys.all, "list"] as const,
  detail: (id: string) => [...channelKeys.all, "detail", id] as const,
  syncSettings: (id: string) => [...channelKeys.all, "sync-settings", id] as const,
  instagramPending: (id: string) => [...channelKeys.all, "instagram-pending", id] as const,
};

/** Fetch all connected channels for the current organization. */
export function useChannels() {
  return useQuery({
    queryKey: channelKeys.list(),
    queryFn: () => channelService.list(),
    // Poll only while something is actually syncing, and stop by itself once
    // it settles. Without this IN_PROGRESS was a dead end in the UI: the row
    // never advanced until the user navigated away and back (staleTime is 30s
    // and refetchOnWindowFocus is off). Same pattern as use-product-queries.
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.syncStatus === "IN_PROGRESS") ? 3000 : false,
  });
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
