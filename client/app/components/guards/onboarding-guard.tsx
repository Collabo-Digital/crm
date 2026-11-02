import { Navigate, useLocation } from "react-router";
import { useAuthStore } from "~/stores/auth.store";
import { getLandingPath } from "~/lib/landing-path";

/**
 * Protects /onboarding/* routes.
 *
 * - Not authenticated → /auth/login
 * - Visiting /onboarding/choose-plan → /onboarding/account-type (feature hidden)
 * - Already has organizations AND not on invite-team page → /dashboard
 * - Otherwise → render children
 */
export function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, organizations } = useAuthStore();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/auth/login" replace />;
  }

  const { pathname } = location;

  // Pricing/billing step is hidden from users for now. Bounce direct visits.
  if (pathname.includes("choose-plan")) {
    return <Navigate to="/onboarding/account-type" replace />;
  }

  const isInvitePage = pathname.includes("invite-team");

  if (organizations.length > 0 && !isInvitePage) {
    return <Navigate to={getLandingPath()} replace />;
  }

  return <>{children}</>;
}
