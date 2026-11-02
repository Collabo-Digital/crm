import { apiClient } from "~/lib/api-client";
import type { MessagingAnalytics } from "~/types/api";

export interface MessagingAnalyticsParams {
  days: 7 | 30 | 90;
  channelId?: string;
}

/** Analytics → Messaging (`/analytics/messaging`). */
export const messagingAnalyticsService = {
  overview: (params: MessagingAnalyticsParams) =>
    apiClient.get<MessagingAnalytics>("/analytics/messaging", { params }).then((r) => r.data),

  /** Fetches a CSV with the session's token and saves it in the browser. */
  download: async (kind: "agents" | "daily", params: MessagingAnalyticsParams) => {
    const response = await apiClient.get<Blob>(`/analytics/messaging/${kind}.csv`, { params, responseType: "blob" });
    const url = URL.createObjectURL(response.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${kind === "agents" ? "team" : "messages"}-${params.days}d.csv`;
    link.click();
    URL.revokeObjectURL(url);
  },
};
