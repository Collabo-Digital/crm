import { apiClient } from "~/lib/api-client";
import type { GrowthLink, SiteWidgetView, WidgetSettings } from "~/types/api";

/** Campaigns → Growth: chat links with QR codes, and the website button and pop-up. */
export const growthService = {
  links: () => apiClient.get<GrowthLink[]>("/growth/links").then((r) => r.data),
  createLink: (data: { channelId: string; name: string; prefilledText?: string; tag?: string }) =>
    apiClient.post<GrowthLink>("/growth/links", data).then((r) => r.data),
  updateLink: (id: string, data: { name?: string; prefilledText?: string | null; tag?: string | null }) =>
    apiClient.patch<GrowthLink>(`/growth/links/${id}`, data).then((r) => r.data),
  archiveLink: (id: string) => apiClient.delete(`/growth/links/${id}`),
  qr: (id: string, format: "svg" | "png") => apiClient.get<Blob>(`/growth/links/${id}/qr`, { params: { format }, responseType: "blob" }).then((r) => r.data),
  widget: () => apiClient.get<SiteWidgetView>("/growth/widget").then((r) => r.data),
  saveWidget: (data: { channelId: string; enabled: boolean; settings: WidgetSettings; allowedDomains: string[] }) =>
    apiClient.put<SiteWidgetView>("/growth/widget", data).then((r) => r.data),
};
