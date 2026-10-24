import { useEffect } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuthStore } from "~/stores/auth.store";
import { readTokenOrgId } from "~/lib/jwt";
import { loginPath, rememberAfterOnboarding } from "~/lib/return-path";

/**
 * Protects /app/* routes.
 *
 * - Not authenticated → /auth/login, coming back here after signing in
 * - No organizations → /onboarding/account-type, coming back here after it
 * - No currentOrgId → adopt the org the ACCESS TOKEN names (falling back to
 *   the first membership), so the UI and the server agree on the tenant
 * - All checks pass → render children
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  // Selectors rather than the whole store: subscribing to everything re-rendered
  // this guard and its entire subtree on every token refresh.
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const organizations = useAuthStore((s) => s.organizations);
  const currentOrgId = useAuthStore((s) => s.currentOrgId);
  const setCurrentOrg = useAuthStore((s) => s.setCurrentOrg);
  const location = useLocation();
  const here = location.pathname + location.search;
  const needsWorkspace = isAuthenticated && !!accessToken && organizations.length === 0;

  // Adopt an org when none is selected yet.
  //
  // Prefer the one the access token was minted for: the server resolves the
  // tenant from that token, so defaulting to `organizations[0]` could leave the
  // UI fetching org A's settings while every request is answered for org B.
  // Runs in an effect, not the render body — setting store state during render
  // triggers React's "cannot update a component while rendering" warning and an
  // extra render pass on every guarded navigation.
  useEffect(() => {
    if (currentOrgId || organizations.length === 0) return;

    const tokenOrgId = readTokenOrgId(accessToken);
    const fromToken = tokenOrgId
      ? organizations.find((m) => m.organization.id === tokenOrgId)
      : undefined;

    setCurrentOrg(
      (fromToken ?? organizations[0]).organization.id,
    );
  }, [currentOrgId, organizations, accessToken, setCurrentOrg]);

  // A new account arriving from the Shopify install link has to make its
  // workspace first; the link is opened once that is done.
  useEffect(() => {
    if (needsWorkspace) rememberAfterOnboarding(here);
  }, [needsWorkspace, here]);

  if (!isAuthenticated || !accessToken) {
    return <Navigate to={loginPath(here)} replace />;
  }

  if (needsWorkspace) {
    return <Navigate to="/onboarding/account-type" replace />;
  }

  return <>{children}</>;
}
