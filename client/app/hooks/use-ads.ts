import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { adsService } from "~/services/ads.service";

export const adsKeys = {
  all: ["ads"] as const,
  report: (days: number) => [...adsKeys.all, "report", days] as const,
  conversions: () => [...adsKeys.all, "conversions"] as const,
};

export function useAdsReport(days: number) {
  return useQuery({ queryKey: adsKeys.report(days), queryFn: () => adsService.report(days) });
}

export function useConversionSettings() {
  return useQuery({ queryKey: adsKeys.conversions(), queryFn: adsService.conversions });
}

/** Connect (after Meta's popup), choose an account, or disconnect. */
export function useAdAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: { kind: "connect"; code: string; state: string } | { kind: "choose"; externalId: string } | { kind: "disconnect" }): Promise<void> => {
      if (action.kind === "connect") await adsService.connect({ code: action.code, state: action.state });
      else if (action.kind === "choose") await adsService.choose(action.externalId);
      else await adsService.disconnect();
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: adsKeys.all }),
    onError: (error) => handleMutationError(error, "The ad account was not updated."),
  });
}

export function useConversionsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, enabled }: { channelId: string; enabled: boolean }) => adsService.setConversions(channelId, enabled),
    onSuccess: (rows) => queryClient.setQueryData(adsKeys.conversions(), rows),
    onError: (error) => handleMutationError(error, "Conversions were not updated."),
  });
}
