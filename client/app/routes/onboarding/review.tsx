import type { ReactNode } from "react";
import { Link, Navigate } from "react-router";
import { ArrowLeft, Check, CircleAlert, Loader2, Pencil } from "lucide-react";

import { StepFrame } from "~/components/app/onboarding/step-frame";
import { QueryErrorState } from "~/components/app/query-error-state";
import { Button } from "~/components/ui/button";
import { StatusBadge } from "~/components/ui/status-badge";
import { useOnboardingWizard, useSetupSummary, useUpdateOnboardingMutation, useWizardStep } from "~/hooks/use-onboarding";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { CATEGORIES, optionLabel, ORDER_VOLUMES, SELL_MODELS, TEAM_SIZES } from "~/lib/onboarding-business";
import { clearOnboardingDraft } from "~/lib/onboarding-draft";
import { onboardingStepPath, type OnboardingStepId } from "~/lib/onboarding-steps";
import { formatPhone } from "~/lib/pos-cart";
import type { StatusTone } from "~/lib/status-tone";
import { cn } from "~/lib/utils";

export function meta() {
  return [{ title: "Review and finish | Collabo CRM" }];
}

const ROLE_LABELS: Record<string, string> = { ADMIN: "Admin", MANAGER: "Manager", AGENT: "Agent", VIEWER: "Viewer" };

const CHANNEL_STATES: Record<"connected" | "attention" | "none", { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "success" },
  attention: { label: "Needs attention", tone: "critical" },
  none: { label: "Not connected", tone: "neutral" },
};

/** "A", "A and B", "A, B and C". */
const listed = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

function SummaryCard({
  title,
  step,
  lead,
  className,
  children,
}: {
  title: string;
  /** The step its Edit link opens. */
  step: OnboardingStepId;
  /** A mark before the title: the business's initials. */
  lead?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("rounded-xl bg-card p-5 shadow-sm ring-1 ring-border sm:p-6", className)}>
      <div className="flex items-center gap-3">
        {lead}
        <h2 className="min-w-0 flex-1 text-section">{title}</h2>
        <Button variant="ghost" size="sm" asChild>
          <Link to={onboardingStepPath(step)}>
            <Pencil aria-hidden />
            Edit<span className="sr-only"> {title.toLowerCase()}</span>
          </Link>
        </Button>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-body font-medium">{children || <span className="text-muted-foreground">Not added</span>}</dd>
    </div>
  );
}

/**
 * Setup's last step: everything collected so far, read back from the server,
 * with an Edit link on each part. Finish closes setup for the workspace.
 * Optional steps never hold it up, so a channel that needs attention is
 * listed and left for later; an unfinished required step is the only thing
 * that blocks.
 */
export default function ReviewStepPage() {
  const { userId, orgId, orgName, onboarding, completedSteps } = useOnboardingWizard();
  const step = useWizardStep("review");
  const finish = useUpdateOnboardingMutation(orgId);
  const { isTeam, organization, providers, invited, isLoading, isError, refetch } = useSetupSummary();

  if (!onboarding) return null;
  // Finished, here or in another tab: the completion page takes over.
  if (onboarding.status !== "IN_PROGRESS") return <Navigate to="/onboarding/done" replace />;

  const profile = onboarding.progress.businessProfile;
  const unfinished = (["organization", "business"] as const).filter((required) => !completedSteps.has(required));
  const needAttention = providers.filter((provider) => provider.state === "attention").map((provider) => provider.label);
  const busy = finish.isPending || step.isLeaving;

  function handleFinish() {
    finish.mutate(
      { finish: true },
      {
        // The step sees the finished status and hands over to the completion page.
        onSuccess: () => clearOnboardingDraft(userId),
        onError: (error) => handleMutationError(error, "Setup couldn't be finished. Try again."),
      },
    );
  }

  return (
    <StepFrame
      title="Review and finish"
      description="Check everything looks right. You can change any of it later in Settings."
      status="Progress saved"
      exit={
        <Button variant="outline" disabled={busy} onClick={() => void step.exit()}>
          {step.isLeaving && <Loader2 className="animate-spin" aria-hidden />}
          Save & exit
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" asChild>
            <Link to={step.previousPath ?? "/onboarding"}>
              <ArrowLeft aria-hidden />
              Previous
            </Link>
          </Button>
          <Button size="lg" className="h-11 px-5" disabled={busy || unfinished.length > 0} onClick={handleFinish}>
            {finish.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Finish setup
            {!finish.isPending && <Check aria-hidden />}
          </Button>
        </>
      }
    >
      {unfinished.length > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-xl bg-danger-subtle px-4 py-3 text-body text-danger-text">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <span className="font-semibold">Finish these steps first: </span>
            {unfinished.map((required, index) => (
              <span key={required}>
                {index > 0 && ", "}
                <Link to={onboardingStepPath(required)} className="font-medium underline underline-offset-4">
                  {required === "organization" ? "Organization" : "Business profile"}
                </Link>
              </span>
            ))}
            .
          </p>
        </div>
      )}

      {needAttention.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl bg-warning-subtle px-4 py-3 text-body text-warning-text">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">
              {needAttention.length === 1 ? "1 thing is" : `${needAttention.length} things are`} still open
            </p>
            <p>
              {listed(needAttention)} {needAttention.length === 1 ? "needs" : "need"} reconnecting. You can finish now and
              sort this out from Settings › Channels.
            </p>
          </div>
        </div>
      )}

      {isError ? (
        <QueryErrorState resource="your setup details" onRetry={refetch} />
      ) : isLoading || !organization ? (
        <div className="flex min-h-40 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading your details" />
        </div>
      ) : (
        <>
          <SummaryCard
            title="Organization"
            step="organization"
            lead={
              <span
                aria-hidden
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-forest text-caption font-semibold uppercase text-ink-foreground"
              >
                {(orgName ?? organization.name).slice(0, 2)}
              </span>
            }
          >
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
              <Fact label="Business name">{organization.name}</Fact>
              <Fact label="Industry">{organization.industry}</Fact>
              <Fact label="Website">{organization.website}</Fact>
              <Fact label="Contact">
                {[organization.email, formatPhone(organization.phone)].filter(Boolean).join(" · ")}
              </Fact>
              <Fact label="Location">
                {[organization.city, [organization.state, organization.pin].filter(Boolean).join(" "), organization.country]
                  .filter(Boolean)
                  .join(", ")}
              </Fact>
              <Fact label="GSTIN">
                {organization.gstRegistered
                  ? [organization.gstin, organization.legalName].filter(Boolean).join(" · ")
                  : "Not GST registered"}
              </Fact>
            </dl>
          </SummaryCard>

          <SummaryCard title="Business profile" step="business">
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
              <Fact label="How you sell">{profile.sellModel && optionLabel(SELL_MODELS, profile.sellModel)}</Fact>
              <Fact label="Orders a month">{profile.ordersPerMonth && optionLabel(ORDER_VOLUMES, profile.ordersPerMonth)}</Fact>
              {isTeam && <Fact label="Team size">{profile.teamSize && optionLabel(TEAM_SIZES, profile.teamSize)}</Fact>}
              <div className="sm:col-span-3">
                <dt className="text-caption text-muted-foreground">Categories</dt>
                <dd className="mt-1.5 flex flex-wrap gap-1.5">
                  {profile.categories.length === 0 ? (
                    <span className="text-body text-muted-foreground">Not added</span>
                  ) : (
                    profile.categories.map((category) => (
                      <span key={category} className="rounded-full bg-muted px-2.5 py-1 text-micro font-medium">
                        {optionLabel(CATEGORIES, category)}
                      </span>
                    ))
                  )}
                </dd>
              </div>
            </dl>
          </SummaryCard>

          {isTeam && (
            <div className="grid gap-5 md:grid-cols-2">
              <SummaryCard title="Sales channels" step="channels">
                <ul className="space-y-2.5">
                  {providers.map((provider) => (
                    <li key={provider.platform} className="flex items-center justify-between gap-3 text-body">
                      <span className="min-w-0 truncate">{provider.label}</span>
                      <StatusBadge tone={CHANNEL_STATES[provider.state].tone} dot>
                        {CHANNEL_STATES[provider.state].label}
                      </StatusBadge>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-3 text-body">
                    <span>Manual orders</span>
                    <StatusBadge tone="success" dot>
                      Always on
                    </StatusBadge>
                  </li>
                </ul>
              </SummaryCard>

              <SummaryCard title="Team" step="team">
                <ul className="space-y-2.5">
                  <li className="flex items-center justify-between gap-3 text-body">
                    <span>You</span>
                    <span className="text-muted-foreground">Owner</span>
                  </li>
                  {invited.map((invite) => (
                    <li key={invite.id} className="flex items-center justify-between gap-3 text-body">
                      <span className="min-w-0 truncate">{invite.email}</span>
                      <span className="shrink-0 text-muted-foreground">{ROLE_LABELS[invite.role] ?? invite.role} · invited</span>
                    </li>
                  ))}
                </ul>
              </SummaryCard>
            </div>
          )}
        </>
      )}
    </StepFrame>
  );
}
