import { Navigate, useLocation } from "react-router";

import { useOnboardingWizard } from "~/hooks/use-onboarding";
import { readTokenOrgId } from "~/lib/jwt";
import { onboardingStepFromPath } from "~/lib/onboarding-steps";
import { getLandingPath } from "~/lib/sections";
import { useAuthStore } from "~/stores/auth.store";

/** The wizard's entry point: it forwards to the step to resume at. */
const RESUME = "/onboarding";

/** The pages open before a workspace exists: the entry point and the two steps that lead to creating one. */
const BEFORE_WORKSPACE = new Set(["onboarding", "welcome", "organization"]);

/**
 * Protects /onboarding/* routes.
 *
 * - Not authenticated → /auth/login
 * - /onboarding/choose-plan → the wizard (the plan step is switched off)
 * - No workspace yet → only the entry point, Welcome and Organization open;
 *   any later step goes back to the entry point
 * - Has a workspace → the wizard is its owner's, while it is still in setup:
 *   a member who isn't the owner, a session not yet scoped to the workspace
 *   (AuthGuard does that), or a finished workspace all go to the app
 */
export function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const accessToken = useAuthStore((state) => state.accessToken);
  const hasWorkspace = useAuthStore((state) => state.organizations.length > 0);
  const { orgId, onboarding, stepIndex, isLoading, isError } = useOnboardingWizard();
  const { pathname } = useLocation();
  const page = pathname.replace(/\/+$/, "").split("/").pop() ?? "";

  if (!isAuthenticated) {
    return <Navigate to="/auth/login" replace />;
  }

  // Pricing/billing step is hidden from users for now. Bounce direct visits.
  if (page === "choose-plan") {
    return <Navigate to={RESUME} replace />;
  }

  if (!hasWorkspace) {
    return BEFORE_WORKSPACE.has(page) ? <>{children}</> : <Navigate to={RESUME} replace />;
  }

  if (!orgId || readTokenOrgId(accessToken) !== orgId || isError) {
    return <Navigate to={getLandingPath()} replace />;
  }

  if (isLoading || !onboarding) {
    // Welcome and Organization stay mounted: saving Organization is what
    // creates the workspace, and unmounting the form mid-save would drop it.
    if (page === "welcome" || page === "organization") return <>{children}</>;
    return (
      <div className="flex min-h-svh items-center justify-center bg-surface-sunken">
        <p role="status" className="text-body text-muted-foreground">
          Opening setup…
        </p>
      </div>
    );
  }

  // Once setup is finished only the completion page is left. Review is let
  // through because finishing happens on it: it hands over to that page itself.
  if (onboarding.status !== "IN_PROGRESS" && page !== "done" && page !== "review") {
    return <Navigate to={getLandingPath()} replace />;
  }

  // A step this workspace doesn't have: the channel and team steps of a "Just me" workspace.
  if (onboardingStepFromPath(pathname) && stepIndex === -1) {
    return <Navigate to={RESUME} replace />;
  }

  return <>{children}</>;
}
