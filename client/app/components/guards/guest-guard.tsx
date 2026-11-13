import { Navigate, useLocation } from "react-router";
import { useAuthStore } from "~/stores/auth.store";
import { getLandingPath } from "~/lib/sections";

/**
 * Protects /auth/* routes from authenticated users.
 *
 * - Authenticated with orgs → /dashboard (except /auth/invite which is always accessible)
 * - Authenticated without orgs → /onboarding (the setup wizard)
 * - Not authenticated → render children (show auth pages)
 *
 * The invite page is always accessible because an existing logged-in user
 * might click an invite link to join another organization.
 */
export function GuestGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, organizations } = useAuthStore();
  const location = useLocation();

  // Always allow access to invite page (existing users can accept invites)
  const isInvitePage = location.pathname.includes("/auth/invite");
  if (isInvitePage) {
    return <>{children}</>;
  }

  if (isAuthenticated && organizations.length > 0) {
    return <Navigate to={getLandingPath()} replace />;
  }

  if (isAuthenticated && organizations.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
