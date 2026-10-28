import { Fragment } from "react";

import { cn } from "~/lib/utils";

/**
 * Where a new owner is in setting up. The plan step is hidden for now (see
 * OnboardingGuard), so the visible steps are the account type, the
 * organisation and the team.
 */
export function OnboardingSteps({ current, total = 3 }: { current: number; total?: number }) {
  return (
    <div className="mb-8 flex items-center justify-center gap-2">
      <div className="flex items-center gap-1.5" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <Fragment key={i}>
            {i > 0 && <div className="h-px w-6 bg-border" />}
            <div className={cn("size-2 rounded-full", i + 1 === current ? "bg-brand-strong" : i + 1 < current ? "bg-muted-foreground" : "bg-border")} />
          </Fragment>
        ))}
      </div>
      <span className="ml-2 text-xs text-muted-foreground">
        Step {current} of {total}
      </span>
    </div>
  );
}
