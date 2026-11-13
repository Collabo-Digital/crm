import { Link, Navigate, useNavigate } from "react-router";
import { ArrowRight, Check } from "lucide-react";

import { BrandLogo } from "~/components/app/brand-logo";
import { SETUP_STEPS } from "~/components/app/get-started-card";
import { Button } from "~/components/ui/button";
import { useSetupProgress } from "~/hooks/use-dashboard-queries";
import { useOnboardingWizard, useSetupSummary } from "~/hooks/use-onboarding";
import { timezoneLabel } from "~/lib/org-options";
import { takeAfterOnboarding } from "~/lib/return-path";
import { getLandingPath } from "~/lib/sections";
import { cn } from "~/lib/utils";
import { useAuthStore } from "~/stores/auth.store";

export function meta() {
  return [{ title: "Your workspace is ready | Collabo CRM" }];
}

/** How many of the dashboard's setup jobs are suggested here. The rest wait on the dashboard. */
const SUGGESTIONS = 3;

function Standing({ label, value, note, attention = false }: { label: string; value: string; note: string; attention?: boolean }) {
  return (
    <div className="min-w-0 p-4">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-section">{value}</dd>
      <dd className={cn("mt-1 text-caption", attention ? "text-warning-text" : "text-muted-foreground")}>{note}</dd>
    </div>
  );
}

/**
 * Shown once setup is finished: where the workspace stands, and the first
 * jobs still open. Those jobs are the dashboard's own setup checklist, so
 * what is suggested here is exactly what the dashboard goes on showing.
 */
export default function SetupDonePage() {
  const navigate = useNavigate();
  const email = useAuthStore((state) => state.user?.email);
  const { orgName, onboarding } = useOnboardingWizard();
  const { isTeam, organization, providers, invited } = useSetupSummary();
  const { data: setup } = useSetupProgress(!!onboarding && onboarding.status !== "IN_PROGRESS");

  if (!onboarding) return null;
  // Not finished yet: back to the step setup was left on.
  if (onboarding.status === "IN_PROGRESS") return <Navigate to="/onboarding" replace />;

  const connected = providers.filter((provider) => provider.state === "connected").length;
  const needLook = providers.filter((provider) => provider.state === "attention").length;
  const suggestions = setup
    ? SETUP_STEPS.filter((job) => (isTeam || !job.teamOnly) && !job.done(setup)).slice(0, SUGGESTIONS)
    : [];

  return (
    <div className="min-h-svh">
      <div className="bg-brand-forest px-4 pb-28 pt-6 text-ink-foreground sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <BrandLogo variant="light" className="h-6" />
          {email && <span className="min-w-0 truncate text-body opacity-80">{email}</span>}
        </div>
        <div className="mx-auto mt-12 max-w-2xl text-center">
          <span className="mx-auto grid size-16 place-items-center rounded-full bg-brand text-brand-foreground ring-8 ring-ink-foreground/10">
            <Check className="size-7" aria-hidden />
          </span>
          <h1 className="mt-6 font-heading text-stat">{orgName ?? "Your workspace"} is ready</h1>
          <p className="mt-3 text-body opacity-90">Your workspace is set up. Here's where things stand.</p>
        </div>
      </div>

      <div className="mx-auto -mt-16 max-w-5xl px-4 pb-16 sm:px-8">
        <dl
          className={cn(
            "grid rounded-xl bg-card p-2 shadow-sm ring-1 ring-border sm:grid-cols-2",
            isTeam && "lg:grid-cols-4",
          )}
        >
          <Standing
            label="Organization"
            value={orgName ?? "—"}
            note={organization ? (organization.gstRegistered ? "GST invoices on" : "GST invoices off") : " "}
          />
          {isTeam && (
            <>
              <Standing
                label="Sales channels"
                value={`${connected} connected`}
                note={
                  needLook > 0
                    ? `${needLook} ${needLook === 1 ? "needs" : "need"} a look`
                    : connected > 0
                      ? "Bringing in orders and chats"
                      : "Connect them in Settings"
                }
                attention={needLook > 0}
              />
              <Standing
                label="Team"
                value={`${invited.length} invited`}
                note={invited.length > 0 ? "Emails on their way" : "Invite people in Settings"}
              />
            </>
          )}
          <Standing
            label="Timezone"
            value={organization ? timezoneLabel(organization.timezone) : "—"}
            note="Reports use this"
          />
        </dl>

        {suggestions.length > 0 && (
          <section className="mt-10">
            <h2 className="text-section">Recommended next</h2>
            <ul className="mt-4 grid gap-4 md:grid-cols-3">
              {suggestions.map((job) => {
                const actions = job.actions(setup!).filter((entry) => !!entry);
                // A "Just me" workspace can't connect channels, so it is sent to the job's other way in.
                const action = actions.find((entry) => isTeam || entry.to !== "/settings/channels") ?? actions[0];
                return (
                  <li key={job.title}>
                    <Link
                      to={action ? action.to : getLandingPath()}
                      className="block h-full rounded-xl bg-card p-5 shadow-sm ring-1 ring-border transition-colors hover:ring-input"
                    >
                      <span className="block text-body font-semibold">{job.title}</span>
                      <span className="mt-1 block text-body text-muted-foreground">{job.why}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!isTeam && (
          <p className="mt-8 text-body text-muted-foreground">
            Working with other people later?{" "}
            <Link to="/settings/general" className="font-medium text-brand-strong underline underline-offset-4">
              Upgrade to a team workspace
            </Link>{" "}
            to connect sales channels and invite them.
          </p>
        )}

        <div className="mt-10 text-center">
          <Button size="lg" className="h-11 px-6" onClick={() => navigate(takeAfterOnboarding() ?? getLandingPath())}>
            Go to dashboard
            <ArrowRight aria-hidden />
          </Button>
          {suggestions.length > 0 && (
            <p className="mt-3 text-caption text-muted-foreground">These suggestions stay on your dashboard until they're done.</p>
          )}
        </div>
      </div>
    </div>
  );
}
