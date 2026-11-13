import { Outlet, useLocation } from "react-router";

import { OnboardingGuard } from "~/components/guards/onboarding-guard";
import { WizardMobileProgress, WizardSidebar } from "~/components/app/onboarding/wizard-sidebar";

/**
 * The setup wizard's shell: the progress sidebar (a strip on phones) beside
 * the step on screen. Each step draws its own top bar and Previous / Continue
 * row through `StepFrame`, because what "Save & exit" has to save differs by
 * step.
 */
export default function OnboardingLayout() {
  // The completion page comes after the steps, so it stands alone.
  const isCompletionPage = useLocation().pathname.replace(/\/+$/, "").endsWith("/onboarding/done");

  return (
    <OnboardingGuard>
      <div className="flex min-h-svh bg-surface-sunken text-foreground max-lg:flex-col">
        {!isCompletionPage && (
          <>
            <WizardSidebar />
            <WizardMobileProgress />
          </>
        )}
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </OnboardingGuard>
  );
}
