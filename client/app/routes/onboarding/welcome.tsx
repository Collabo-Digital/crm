import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Loader2, Megaphone, MessageCircle, ShoppingBag, User, Users, type LucideIcon } from "lucide-react";

import { WizardTopBar } from "~/components/app/onboarding/step-frame";
import { Button } from "~/components/ui/button";
import { useOnboardingWizard, useUpgradeWorkspaceToTeam } from "~/hooks/use-onboarding";
import { messagingChannelWords } from "~/lib/channel-providers";
import { updateOnboardingDraft } from "~/lib/onboarding-draft";
import { onboardingStepPath } from "~/lib/onboarding-steps";
import { getLandingPath } from "~/lib/sections";
import { signOut } from "~/lib/sign-out";
import { cn } from "~/lib/utils";
import { useAuthStore } from "~/stores/auth.store";
import type { OnboardingAudience } from "~/types/api";

export function meta() {
  return [{ title: "Welcome | Collabo CRM" }];
}

const FEATURES: ReadonlyArray<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: MessageCircle,
    title: "Every chat, one inbox",
    body: `Answer ${messagingChannelWords("and")} customers with your team.`,
  },
  {
    icon: ShoppingBag,
    title: "Orders and stock in sync",
    body: "Shopify and manual orders, inventory and GST invoices.",
  },
  {
    icon: Megaphone,
    title: "Campaigns that sell",
    body: "Broadcasts, automations and loyalty for repeat buyers.",
  },
];

const AUDIENCES: ReadonlyArray<{ value: OnboardingAudience; icon: LucideIcon; title: string; body: string }> = [
  { value: "solo", icon: User, title: "Just me", body: "Solo workspace, invite people later" },
  { value: "team", icon: Users, title: "My team", body: "Roles and access for each person" },
];

/**
 * Setup step 1: what Collabo does, and who will use it.
 *
 * Nothing is saved to the server here. Before the workspace exists the choice
 * lives in the browser draft and decides which kind the Organization step
 * creates. After it exists, "Just me" can still become "My team" (the
 * workspace is upgraded in place); a team workspace cannot go back.
 */
export default function WelcomeStepPage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const { userId, orgId, orgName, audience } = useOnboardingWizard();
  const upgrade = useUpgradeWorkspaceToTeam();
  // Only for a "Just me" workspace that already exists: the choice is applied on Continue.
  const [wantsTeam, setWantsTeam] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const isTeamWorkspace = !!orgId && audience === "team";
  const selected: OnboardingAudience = orgId && wantsTeam ? "team" : audience;

  function choose(value: OnboardingAudience) {
    if (orgId) setWantsTeam(value === "team");
    else updateOnboardingDraft(userId, { audience: value });
  }

  async function handleContinue() {
    if (orgId && audience === "solo" && wantsTeam) {
      try {
        await upgrade.mutateAsync({ orgId, name: orgName ?? "" });
      } catch {
        // The mutation has already said why; stay on the step.
        return;
      }
    }
    if (!orgId) updateOnboardingDraft(userId, { step: "organization" });
    navigate(onboardingStepPath("organization"));
  }

  // The auth pages send a signed-in member without a workspace straight back
  // here, so signing out is the only way to switch accounts.
  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    navigate("/auth/login");
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 lg:py-8">
      <WizardTopBar>
        {user?.email && (
          <span className="hidden truncate text-body text-muted-foreground sm:inline">Signed in as {user.email}</span>
        )}
        {orgId ? (
          <Button variant="outline" onClick={() => navigate(getLandingPath())}>
            Save & exit
          </Button>
        ) : (
          <Button variant="outline" disabled={signingOut} onClick={() => void handleSignOut()}>
            Sign out
          </Button>
        )}
      </WizardTopBar>

      <header className="mt-10 lg:mt-16">
        <span className="rounded-full bg-brand px-2.5 py-1 text-micro font-medium text-brand-foreground">About 5 minutes</span>
        <h1 className="mt-4 font-heading text-stat">Welcome to Collabo{user?.firstName ? `, ${user.firstName}` : ""}</h1>
        <p className="mt-3 max-w-2xl text-body text-muted-foreground">
          Collabo brings your store, your customer chats and your team into one place. Let's set up your workspace.
        </p>
      </header>

      <ul className="mt-8 grid gap-4 sm:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <li key={title} className="rounded-xl bg-card p-5 shadow-sm ring-1 ring-border">
            <span className="grid size-9 place-items-center rounded-lg bg-surface-sunken text-brand-strong">
              <Icon className="size-4" aria-hidden />
            </span>
            <h2 className="mt-4 text-section">{title}</h2>
            <p className="mt-1 text-body text-muted-foreground">{body}</p>
          </li>
        ))}
      </ul>

      <fieldset className="mt-8">
        <legend className="text-section">Who will use Collabo?</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {AUDIENCES.map(({ value, icon: Icon, title, body }) => {
            const checked = selected === value;
            // A team workspace stays one: channels and invites may already hang off it.
            const locked = isTeamWorkspace && value === "solo";
            return (
              <label
                key={value}
                className={cn(
                  "flex items-center gap-4 rounded-xl border bg-card p-4 transition-colors",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  checked ? "border-brand-strong bg-brand/15 ring-2 ring-brand/60" : "border-border",
                  locked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-input",
                )}
              >
                <input
                  type="radio"
                  name="audience"
                  value={value}
                  checked={checked}
                  disabled={locked || upgrade.isPending}
                  onChange={() => choose(value)}
                  className="sr-only"
                />
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand/30">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-section">{title}</span>
                  <span className="block text-body text-muted-foreground">{body}</span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border",
                    checked ? "border-brand-strong" : "border-input",
                  )}
                >
                  {checked && <span className="size-2.5 rounded-full bg-brand-strong" />}
                </span>
              </label>
            );
          })}
        </div>
        {isTeamWorkspace && (
          <p className="mt-3 text-caption text-muted-foreground">
            This workspace is already set up for a team, so it can't go back to Just me.
          </p>
        )}
        {orgId && !isTeamWorkspace && wantsTeam && (
          <p className="mt-3 text-caption text-muted-foreground">
            Continuing changes this workspace to a team workspace. That adds the sales channel and team steps, and
            can't be undone.
          </p>
        )}
      </fieldset>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <p className="text-body text-muted-foreground">Next: your organization details</p>
        <Button size="lg" className="h-11 px-5" disabled={upgrade.isPending} onClick={() => void handleContinue()}>
          {upgrade.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {orgId ? "Continue" : "Get started"}
          {!upgrade.isPending && <ArrowRight aria-hidden />}
        </Button>
      </footer>
    </div>
  );
}
