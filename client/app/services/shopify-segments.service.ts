import { apiClient } from "~/lib/api-client";
import type { ShopifySegmentView, ShopifySegmentsList } from "~/types/api";

/** Customer segments from the Shopify admin, linked as audiences. */
export const shopifySegmentsService = {
  list: () => apiClient.get<ShopifySegmentsList>("/campaigns/shopify-segments").then((r) => r.data),
  link: (externalId: string) => apiClient.post<ShopifySegmentView>("/campaigns/shopify-segments", { externalId }).then((r) => r.data),
  sync: (id: string) => apiClient.post<ShopifySegmentView>(`/campaigns/shopify-segments/${id}/sync`).then((r) => r.data),
  unlink: (id: string) => apiClient.delete(`/campaigns/shopify-segments/${id}`),
};
