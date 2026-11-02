import { Navigate, useLocation } from "react-router";
import { useAuthStore } from "~/stores/auth.store";
import { useBillingPlans } from "~/hooks/use-billing";
import { getLandingPath } from "~/lib/sections";

/**
 * Protects /onboarding/* routes.
 *
 * - Not authenticated → /auth/login
 * - Visiting /onboarding/choose-plan while the server has the payment step
 *   off (BILLING_ENFORCEMENT) → /onboarding/account-type
 * - Already has organizations AND not on invite-team page → /dashboard
 * - Otherwise → render children
 */
export function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, organizations } = useAuthStore();
  const location = useLocation();
  const { pathname } = location;
  const choosingPlan = pathname.includes("choose-plan");
  const plans = useBillingPlans(isAuthenticated && choosingPlan);

  if (!isAuthenticated) {
    return <Navigate to="/auth/login" replace />;
  }

  // The plan step is there only while the server asks for a plan; until it
  // says, nothing shows.
  if (choosingPlan) {
    if (plans.isPending) return null;
    if (!plans.data?.enforcement) return <Navigate to="/onboarding/account-type" replace />;
  }

  const isInvitePage = pathname.includes("invite-team");

  if (organizations.length > 0 && !isInvitePage) {
    return <Navigate to={getLandingPath()} replace />;
  }

  return <>{children}</>;
}
