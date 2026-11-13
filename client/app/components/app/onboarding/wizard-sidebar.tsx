import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleHelp } from "lucide-react";

import { BrandLogo } from "~/components/app/brand-logo";
import { CHANNEL_LABEL } from "~/components/app/channel-badge";
import { HelpDialog } from "~/components/app/help-dialog";
import { channelKeys } from "~/hooks/use-channel-queries";
import { useOnboardingWizard } from "~/hooks/use-onboarding";
import { useOrgInvites } from "~/hooks/use-org-queries";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { activeChannelsFor, CHANNEL_PROVIDERS } from "~/lib/channel-providers";
import { businessSummary } from "~/lib/onboarding-business";
import { onboardingStepPath, type OnboardingStep } from "~/lib/onboarding-steps";
import { cn } from "~/lib/utils";
import { channelService } from "~/services/channel.service";

/** How far through the wizard the page on screen is, as the design counts it: step 2 of 6 is 33%. */
function useWizardProgress() {
  const { steps, stepIndex } = useOnboardingWizard();
  const position = Math.max(stepIndex, 0);
  return {
    label: `Step ${position + 1} of ${steps.length} · ${steps[position].title}`,
    percent: Math.round(((position + 1) / steps.length) * 100),
  };
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 overflow-hidden rounded-full bg-border"
    >
      <div className="h-full rounded-full bg-brand-strong transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** The wizard's left column on desktop: progress, the step list and help. */
export function WizardSidebar() {
  const { steps, stepIndex, completedSteps, audience, orgId, orgName, onboarding } = useOnboardingWizard();
  const { label, percent } = useWizardProgress();
  const { data: settings } = useOrganizationSettings(!!orgId);
  // Read only once their step is done: that is when the sidebar has something to say about them.
  const { data: channels } = useQuery({
    queryKey: channelKeys.list(),
    queryFn: () => channelService.list(),
    enabled: !!orgId && completedSteps.has("channels"),
  });
  const { data: invites } = useOrgInvites(orgId, completedSteps.has("team"));
  const [helpOpen, setHelpOpen] = useState(false);

  /** What a finished step shows under its title: the answer, where there is a short one. */
  function summary(step: OnboardingStep): string {
    if (!completedSteps.has(step.id)) return step.subtitle;
    if (step.id === "welcome") return audience === "solo" ? "Just me" : "My team";
    if (step.id === "organization") {
      return [orgName, settings?.storeProfileSettings.city].filter(Boolean).join(" · ") || step.subtitle;
    }
    if (step.id === "business" && onboarding) {
      return businessSummary(onboarding.progress.businessProfile) ?? step.subtitle;
    }
    if (step.id === "channels" && channels) {
      const connected = CHANNEL_PROVIDERS.filter((provider) =>
        activeChannelsFor(provider, channels).some((channel) => channel.connectionState === "CONNECTED"),
      );
      if (connected.length === 0) return "None connected yet";
      return connected.length === 1 ? `${CHANNEL_LABEL[connected[0].platform]} connected` : `${connected.length} connected`;
    }
    if (step.id === "team" && invites) {
      const invited = invites.filter((invite) => invite.status === "PENDING").length;
      return invited === 0 ? "No one invited yet" : `${invited} invited`;
    }
    return step.subtitle;
  }

  return (
    <aside className="sticky top-0 hidden h-svh w-80 shrink-0 flex-col overflow-y-auto border-r border-border bg-card px-5 py-6 lg:flex">
      <BrandLogo className="h-6 self-start" />

      <div className="mt-6 rounded-xl bg-surface-sunken p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-body font-semibold">Workspace setup</p>
          <p className="text-body font-medium tabular-nums text-brand-strong">{percent}%</p>
        </div>
        <div className="mt-3">
          <ProgressBar percent={percent} />
        </div>
        <p className="mt-3 text-caption text-muted-foreground">{label}</p>
      </div>

      <nav aria-label="Setup steps" className="mt-6">
        <ol>
          {steps.map((step, index) => {
            const current = index === stepIndex;
            const done = completedSteps.has(step.id);
            const last = index === steps.length - 1;
            const row = (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-full text-body font-semibold",
                    current
                      ? "bg-brand text-brand-foreground ring-2 ring-brand-strong"
                      : done
                        ? "bg-brand-strong text-background"
                        : "bg-card text-muted-foreground ring-1 ring-input",
                  )}
                >
                  {done && !current ? <Check className="size-4" /> : index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={cn("text-body font-semibold", !current && !done && "text-muted-foreground")}>
                      {step.title}
                    </span>
                    {step.optional && (
                      <span className="rounded-full bg-muted px-2 text-micro text-muted-foreground">Optional</span>
                    )}
                  </span>
                  <span className="block truncate text-caption text-muted-foreground">{summary(step)}</span>
                </span>
              </>
            );
            const rowClass = cn("relative flex items-start gap-3 rounded-xl px-3 py-3", current && "bg-brand/25");

            return (
              <li key={step.id} className="relative" aria-current={current ? "step" : undefined}>
                {!last && (
                  <span
                    aria-hidden
                    className={cn("absolute top-11 -bottom-3 left-7 w-px -translate-x-1/2", done ? "bg-brand-strong" : "bg-border")}
                  />
                )}
                {done && !current ? (
                  <Link to={onboardingStepPath(step.id)} className={cn(rowClass, "transition-colors hover:bg-muted")}>
                    {row}
                    <span className="sr-only">Done. Go back to this step.</span>
                  </Link>
                ) : (
                  <div className={rowClass}>{row}</div>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="mt-auto space-y-4 pt-6">
        <p className="flex items-start gap-2 text-caption text-muted-foreground">
          <Check className="mt-px size-3.5 shrink-0 text-brand-strong" aria-hidden />
          Saved as you go. Leave any time and pick up where you left off.
        </p>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-sunken text-brand-strong">
            <CircleHelp className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-body font-semibold">Need a hand?</span>
            <span className="block text-caption text-muted-foreground">Talk to the Collabo team</span>
          </span>
        </button>
      </div>

      {/* The setup guide lives on the dashboard, which setup hasn't reached yet. */}
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} hideSetupGuide />
    </aside>
  );
}

/** The same progress on phones and tablets, where the sidebar is hidden. */
export function WizardMobileProgress() {
  const { label, percent } = useWizardProgress();
  return (
    <div className="border-b border-border bg-card px-4 py-3 lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <BrandLogo className="h-5" />
        <p className="truncate text-caption text-muted-foreground">{label}</p>
      </div>
      <div className="mt-3">
        <ProgressBar percent={percent} />
      </div>
    </div>
  );
}
