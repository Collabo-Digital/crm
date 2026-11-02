import { apiClient } from "~/lib/api-client";
import type {
  BillingConfigResponse,
  BillingPlansResponse,
  BillingUsageSummary,
  PendingStatusResponse,
  StartOnboardingCheckoutRequest,
  StartOnboardingCheckoutResponse,
} from "~/types/api";

/**
 * Service layer for billing API endpoints.
 *
 * Every method returns the unwrapped response data (the api-client interceptor
 * strips the `{ success, data }` envelope, matching the pattern in
 * org.service.ts and auth.service.ts).
 */
export const billingService = {
  /** Fetch the public Razorpay key id used to initialize Checkout.js. */
  getConfig: () =>
    apiClient
      .get<BillingConfigResponse>("/billing/config")
      .then((response) => response.data),

  /** Create a Razorpay Customer + Subscription for the authenticated user. */
  startOnboardingCheckout: (data: StartOnboardingCheckoutRequest) =>
    apiClient
      .post<StartOnboardingCheckoutResponse>(
        "/billing/onboarding-checkout",
        data,
      )
      .then((response) => response.data),

  /** Poll the user's pending-subscription status (waiting for webhook). */
  getPendingStatus: () =>
    apiClient
      .get<PendingStatusResponse>("/billing/pending-status")
      .then((response) => response.data),

  /** The plans and their prices, in rupees and dollars. */
  getPlans: () =>
    apiClient
      .get<BillingPlansResponse>("/billing/plans")
      .then((response) => response.data),

  /** The organization's plan, this month's usage and its usage bills. */
  getUsage: () =>
    apiClient
      .get<BillingUsageSummary>("/billing/usage")
      .then((response) => response.data),
};
