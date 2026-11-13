import { Navigate } from "react-router";
import { useAuthStore } from "~/stores/auth.store";
import { getLandingPath } from "~/lib/sections";

/**
 * Home page (/) — pure redirect, no UI.
 *
 * - Authenticated with orgs → /dashboard
 * - Authenticated without orgs → /onboarding (the setup wizard)
 * - Not authenticated → /auth/login
 */
export default function Home() {
  const { isAuthenticated, organizations } = useAuthStore();

  if (isAuthenticated && organizations.length > 0) {
    return <Navigate to={getLandingPath()} replace />;
  }

  if (isAuthenticated) {
    return <Navigate to="/onboarding" replace />;
  }

  return <Navigate to="/auth/login" replace />;
}
