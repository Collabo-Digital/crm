import type { OnboardingAudience, OnboardingServerStep } from "~/types/api";

/**
 * The setup wizard's steps, in the order the owner sees them.
 *
 * Welcome exists only on the client: it runs before there is a workspace to
 * record anything against. Every other id is one the server tracks (see
 * server/src/organization/onboarding-data.ts).
 *
 * Choose plan becomes the first entry here once billing is switched on.
 */
export type OnboardingStepId = "welcome" | OnboardingServerStep;

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  /** Shown under the title in the sidebar until the step has an answer to show instead. */
  subtitle: string;
  /** Can be skipped; setup finishes without it. */
  optional: boolean;
  /** Hidden for a "Just me" workspace, which cannot connect channels or invite people. */
  teamOnly: boolean;
}

const STEPS: readonly OnboardingStep[] = [
  { id: "welcome", title: "Welcome", subtitle: "Who will use Collabo", optional: false, teamOnly: false },
  { id: "organization", title: "Organization", subtitle: "Name, contact, location, GST", optional: false, teamOnly: false },
  { id: "business", title: "Business profile", subtitle: "What you sell and how much", optional: false, teamOnly: false },
  { id: "channels", title: "Sales channels", subtitle: "Shopify, WhatsApp, Instagram", optional: true, teamOnly: true },
  { id: "team", title: "Team", subtitle: "Invite your staff", optional: true, teamOnly: true },
  { id: "review", title: "Review", subtitle: "Check and finish", optional: false, teamOnly: false },
];

/** The steps this workspace goes through: four for "Just me", six for a team. */
export function onboardingSteps(audience: OnboardingAudience): OnboardingStep[] {
  return STEPS.filter((step) => audience === "team" || !step.teamOnly);
}

export function onboardingStepPath(id: OnboardingStepId): string {
  return `/onboarding/${id}`;
}

/** The step a wizard URL shows, or null for the wizard's other pages (resume, done). */
export function onboardingStepFromPath(pathname: string): OnboardingStepId | null {
  const page = pathname.replace(/\/+$/, "").split("/").pop();
  return STEPS.find((step) => step.id === page)?.id ?? null;
}

/** The step after `id` for this workspace, or null after the last one. */
export function nextOnboardingStep(id: OnboardingStepId, audience: OnboardingAudience): OnboardingStepId | null {
  const steps = onboardingSteps(audience);
  return steps[steps.findIndex((step) => step.id === id) + 1]?.id ?? null;
}

/** The step before `id` for this workspace, or null before the first one. */
export function previousOnboardingStep(id: OnboardingStepId, audience: OnboardingAudience): OnboardingStepId | null {
  const steps = onboardingSteps(audience);
  return steps[steps.findIndex((step) => step.id === id) - 1]?.id ?? null;
}
