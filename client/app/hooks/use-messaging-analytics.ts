import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { messagingAnalyticsService, type MessagingAnalyticsParams } from "~/services/messaging-analytics.service";

export const messagingAnalyticsKeys = {
  overview: (params: MessagingAnalyticsParams) => ["analytics", "messaging", params] as const,
};

/** Keeps the last result on screen while a new period or channel loads. */
export function useMessagingAnalytics(params: MessagingAnalyticsParams) {
  return useQuery({
    queryKey: messagingAnalyticsKeys.overview(params),
    queryFn: () => messagingAnalyticsService.overview(params),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
