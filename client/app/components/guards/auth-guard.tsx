import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { RotateCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useAuthStore } from "~/stores/auth.store";
import { authService } from "~/services/auth.service";
import { readTokenOrgId } from "~/lib/jwt";
import { loginPath, rememberAfterOnboarding } from "~/lib/return-path";
import { currentSessionStamp } from "~/lib/session-cache";
import { signOut } from "~/lib/sign-out";
import { workspaceScope } from "~/lib/workspace-scope";

/**
 * Protects /app/* routes.
 *
 * - Not authenticated → /auth/login, coming back here after signing in
 * - No organizations → /onboarding/account-type, coming back here after it
 * - Token scoped to one of the user's workspaces → `currentOrgId` follows the
 *   token, since the server runs every request in the token's org
 * - Token with no org (or one this browser doesn't know) → get a token scoped
 *   to the selected workspace from /auth/switch-org first; until then no
 *   workspace screen renders (see lib/workspace-scope.ts)
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
  const signedIn = isAuthenticated && !!accessToken;
  const needsWorkspace = signedIn && organizations.length === 0;

  const scope = workspaceScope(organizations, readTokenOrgId(accessToken), currentOrgId);
  const shownOrgId = scope.kind === "show" ? scope.orgId : null;
  const switchTo = signedIn && scope.kind === "switch" ? scope.orgId : null;
  // The org a switch last failed for, and a counter to try it again.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Runs in an effect, not the render body — setting store state during render
  // triggers React's "cannot update a component while rendering" warning and an
  // extra render pass on every guarded navigation.
  useEffect(() => {
    if (shownOrgId && currentOrgId !== shownOrgId) setCurrentOrg(shownOrgId);
  }, [shownOrgId, currentOrgId, setCurrentOrg]);

  useEffect(() => {
    if (!switchTo) return;
    let current = true;
    scopeSessionTo(switchTo).catch(() => {
      if (current) setFailedFor(switchTo);
    });
    return () => {
      current = false;
    };
  }, [switchTo, attempt]);

  // A new account arriving from the Shopify install link has to make its
  // workspace first; the link is opened once that is done.
  useEffect(() => {
    if (needsWorkspace) rememberAfterOnboarding(here);
  }, [needsWorkspace, here]);

  if (!signedIn) {
    return <Navigate to={loginPath(here)} replace />;
  }

  if (needsWorkspace) {
    return <Navigate to="/onboarding/account-type" replace />;
  }

  if (switchTo) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-surface-sunken px-6 text-center">
        {failedFor === switchTo ? (
          <>
            <h1 className="font-heading text-subhead">Your workspace couldn't be opened</h1>
            <p className="max-w-sm text-body text-muted-foreground">
              Check your internet connection and try again. If it keeps happening, sign out and back in.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="outline"
                className="h-11"
                onClick={() => {
                  setFailedFor(null);
                  setAttempt((n) => n + 1);
                }}
              >
                <RotateCw />
                Try again
              </Button>
              <Button variant="outline" className="h-11" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          </>
        ) : (
          <p role="status" className="text-body text-muted-foreground">
            Opening your workspace…
          </p>
        )}
      </div>
    );
  }

  // One frame while the effect above points `currentOrgId` at the token's org.
  if (currentOrgId !== shownOrgId) return null;

  return <>{children}</>;
}

/** The switch in flight, so a remount (or React's dev double effect) joins it rather than minting a second token pair. */
let scoping: { key: string; promise: Promise<void> } | null = null;

/** Swap the session's token for one scoped to `orgId`. */
function scopeSessionTo(orgId: string): Promise<void> {
  const key = `${currentSessionStamp()}>${orgId}`;
  if (scoping?.key === key) return scoping.promise;

  const promise = authService
    .switchOrg({ orgId })
    .then((data) => {
      // One write, so another tab never adopts the new token next to the old
      // org. The API client has already dropped this response if the session
      // changed while it was in flight.
      useAuthStore.setState({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        currentOrgId: data.currentOrganization.id,
      });
    })
    .finally(() => {
      if (scoping?.promise === promise) scoping = null;
    });
  scoping = { key, promise };
  return promise;
}
