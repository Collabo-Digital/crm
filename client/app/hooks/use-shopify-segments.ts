import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { shopifySegmentsService } from "~/services/shopify-segments.service";

export const shopifySegmentKeys = { all: ["shopify-segments"] as const };

export function useShopifySegments(enabled = true) {
  return useQuery({ queryKey: shopifySegmentKeys.all, queryFn: shopifySegmentsService.list, enabled });
}

export function useShopifySegmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (a: { kind: "link"; externalId: string } | { kind: "sync"; id: string } | { kind: "unlink"; id: string }) => {
      if (a.kind === "link") await shopifySegmentsService.link(a.externalId);
      else if (a.kind === "sync") await shopifySegmentsService.sync(a.id);
      else await shopifySegmentsService.unlink(a.id);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: shopifySegmentKeys.all }),
    onError: (error) => handleMutationError(error, "The Shopify segment was not updated."),
  });
}
