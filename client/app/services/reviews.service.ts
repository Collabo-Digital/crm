import { apiClient } from "~/lib/api-client";
import type { ProductReviewStatus, ReviewAccountView, ReviewsList } from "~/types/api";

export interface ReviewFilters {
  rating?: number;
  status?: ProductReviewStatus;
  page?: number;
}

/** Campaigns → Reviews: reviews collected on WhatsApp, and the store's Judge.me. */
export const reviewsService = {
  list: (params: ReviewFilters) => apiClient.get<ReviewsList>("/reviews", { params }).then((r) => r.data),
  account: () => apiClient.get<ReviewAccountView>("/reviews/judgeme").then((r) => r.data),
  connect: (body: { shopDomain: string; apiToken: string }) => apiClient.put<ReviewAccountView>("/reviews/judgeme", body).then((r) => r.data),
  disconnect: () => apiClient.delete("/reviews/judgeme"),
};
