import { apiClient } from "~/lib/api-client";
import type { AdAccountView, AdsReport, ConversionSetting } from "~/types/api";

/** Campaigns → Ads: results per click-to-message ad, the Meta ad account, and conversions. */
export const adsService = {
  report: (days: number) => apiClient.get<AdsReport>("/ads/report", { params: { days } }).then((r) => r.data),
  connectConfig: () => apiClient.get<{ configId: string; state: string }>("/ads/account/connect").then((r) => r.data),
  connect: (data: { code: string; state: string }) => apiClient.post<AdAccountView>("/ads/account/connect", data).then((r) => r.data),
  choose: (externalId: string) => apiClient.put<AdAccountView>("/ads/account", { externalId }).then((r) => r.data),
  disconnect: () => apiClient.delete("/ads/account"),
  conversions: () => apiClient.get<ConversionSetting[]>("/ads/conversions").then((r) => r.data),
  setConversions: (channelId: string, enabled: boolean) => apiClient.put<ConversionSetting[]>(`/ads/conversions/${channelId}`, { enabled }).then((r) => r.data),
};
