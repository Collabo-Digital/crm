import { Navigate } from "react-router";

import { useOnboardingWizard } from "~/hooks/use-onboarding";
import { onboardingStepPath, type OnboardingStepId } from "~/lib/onboarding-steps";

export function meta() {
  return [{ title: "Set up your workspace | Collabo CRM" }];
}

/**
 * /onboarding, and the old step URLs: forwards to the step to resume at.
 * Before the workspace exists that is the step the browser draft was left on;
 * after, the one the server recorded. A step this workspace doesn't have (the
 * team steps of a "Just me" workspace) falls back to Organization.
 */
export default function OnboardingResume() {
  const { orgId, onboarding, draft, steps } = useOnboardingWizard();
  const resumeAt: OnboardingStepId = orgId ? (onboarding?.progress.currentStep ?? "organization") : draft.step;
  const step = steps.some((candidate) => candidate.id === resumeAt) ? resumeAt : "organization";
  return <Navigate to={onboardingStepPath(step)} replace />;
}
