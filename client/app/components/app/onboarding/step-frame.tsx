import type { ReactNode } from "react";
import { Check } from "lucide-react";

import { useOnboardingWizard } from "~/hooks/use-onboarding";

/** The strip above every wizard page: what is saved on the left, the way out on the right. */
export function WizardTopBar({ status, children }: { status?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p role="status" className="flex items-center gap-1.5 text-body text-muted-foreground">
        {status && (
          <>
            <Check className="size-4 shrink-0 text-brand-strong" aria-hidden />
            {status}
          </>
        )}
      </p>
      <div className="flex min-w-0 items-center gap-3">{children}</div>
    </div>
  );
}

/**
 * One numbered wizard step: the top bar, "Step 2 of 6", the heading, the
 * step's cards and its Previous / Continue row. The step number and its
 * Required / Optional mark come from the step list, so a "Just me" workspace
 * counts its own four steps.
 */
export function StepFrame({
  title,
  description,
  status,
  exit,
  footer,
  children,
}: {
  title: string;
  description: ReactNode;
  /** What is saved right now: "Draft saved", "Progress saved". */
  status?: string;
  /** The top-right action: Save & exit, or Save & sign out before the workspace exists. */
  exit: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { steps, stepIndex } = useOnboardingWizard();
  const step = steps[Math.max(stepIndex, 0)];
  // The last step is neither: it only confirms what the others collected.
  const mark = step.optional ? "Optional" : step.id === "review" ? null : "Required";

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 lg:py-8">
      <WizardTopBar status={status}>{exit}</WizardTopBar>

      <header className="mt-8">
        <p className="flex items-center gap-2 text-body font-semibold text-brand-strong">
          Step {Math.max(stepIndex, 0) + 1} of {steps.length}
          {mark && (
            <span
              className={
                step.optional
                  ? "rounded-full bg-brand px-2 text-micro font-medium text-brand-foreground"
                  : "rounded-full bg-muted px-2 text-micro font-medium text-muted-foreground"
              }
            >
              {mark}
            </span>
          )}
        </p>
        <h1 className="mt-2 font-heading text-page-title">{title}</h1>
        <p className="mt-2 text-body text-muted-foreground">{description}</p>
      </header>

      <div className="mt-6 space-y-5">{children}</div>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3">{footer}</footer>
    </div>
  );
}
