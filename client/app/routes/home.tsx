import { Navigate } from "react-router";
import { useAuthStore } from "~/stores/auth.store";
import { getLandingPath } from "~/lib/landing-path";

/**
 * Home page (/) — pure redirect, no UI.
 *
 * - Authenticated with orgs → /dashboard
 * - Authenticated without orgs → /onboarding/account-type
 * - Not authenticated → /auth/login
 */
export default function Home() {
  const { isAuthenticated, organizations } = useAuthStore();

  if (isAuthenticated && organizations.length > 0) {
    return <Navigate to={getLandingPath()} replace />;
  }

  if (isAuthenticated) {
    return <Navigate to="/onboarding/account-type" replace />;
  }

  return <Navigate to="/auth/login" replace />;
}
