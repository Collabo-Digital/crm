import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { reviewsService, type ReviewFilters } from "~/services/reviews.service";

export const reviewKeys = {
  all: ["reviews"] as const,
  list: (filters: ReviewFilters) => [...reviewKeys.all, "list", filters] as const,
  account: () => [...reviewKeys.all, "judgeme"] as const,
};

export function useReviews(filters: ReviewFilters) {
  return useQuery({ queryKey: reviewKeys.list(filters), queryFn: () => reviewsService.list(filters), placeholderData: keepPreviousData });
}

export function useJudgemeAccount() {
  return useQuery({ queryKey: reviewKeys.account(), queryFn: reviewsService.account });
}

/** Connect Judge.me with the shop's private API token (checked, not kept), or disconnect it. */
export function useJudgemeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: { kind: "connect"; shopDomain: string; apiToken: string } | { kind: "disconnect" }): Promise<void> => {
      if (action.kind === "connect") await reviewsService.connect({ shopDomain: action.shopDomain, apiToken: action.apiToken });
      else await reviewsService.disconnect();
    },
    onSuccess: (_data, action) => {
      toast.success(action.kind === "connect" ? "Judge.me connected." : "Judge.me disconnected.");
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
    onError: (error) => handleMutationError(error, "Judge.me was not updated."),
  });
}
