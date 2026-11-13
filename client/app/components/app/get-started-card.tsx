import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, Circle, X } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useSetupProgress } from "~/hooks/use-dashboard-queries";
import { useOnboarding } from "~/hooks/use-onboarding";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { onboardingSteps } from "~/lib/onboarding-steps";
import { cn } from "~/lib/utils";
import { useAuthStore } from "~/stores/auth.store";
import type { SetupProgress } from "~/types/api";

const hiddenKey = (orgId: string) => `collabo.setup-guide.hidden.${orgId}`;
const CHANGED = "collabo:setup-guide";

function readHidden(orgId: string | null): boolean {
  if (!orgId) return false;
  try {
    return localStorage.getItem(hiddenKey(orgId)) === "1";
  } catch {
    return false;
  }
}

function writeHidden(orgId: string, hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(hiddenKey(orgId), "1");
    else localStorage.removeItem(hiddenKey(orgId));
  } catch {
    // Private windows can refuse storage; the guide then just shows again.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Brings a hidden guide back, from Help and support. */
export function showSetupGuide(orgId: string | null) {
  if (orgId) writeHidden(orgId, false);
}

type Step = {
  title: string;
  why: string;
  /** Not for a "Just me" workspace, which can't connect channels or invite people. */
  teamOnly?: boolean;
  done: (p: SetupProgress) => boolean;
  actions: (p: SetupProgress) => Array<{ label: string; to: string } | false>;
};

/** The first jobs of a new store. Also the setup wizard's "Recommended next". */
export const SETUP_STEPS: Step[] = [
  {
    title: "Connect your WhatsApp number",
    why: "Chat with customers and send order updates from Collabo.",
    teamOnly: true,
    done: (p) => p.whatsapp,
    actions: () => [{ label: "Connect WhatsApp", to: "/settings/channels" }],
  },
  {
    title: "Add your products",
    why: "Connect your Shopify store to bring them in, or add them here.",
    done: (p) => p.catalogue,
    actions: () => [
      { label: "Connect Shopify", to: "/settings/channels" },
      { label: "Add products", to: "/products" },
    ],
  },
  {
    title: "Set up your store profile and GST",
    why: "Your address, contact number, logo and GSTIN print on every invoice and packing slip.",
    done: (p) => p.storeProfile && p.gst,
    actions: (p) => [
      !p.storeProfile && { label: "Store profile", to: "/settings/store-profile" },
      !p.gst && { label: "Add your GSTIN", to: "/settings/tax-gst" },
    ],
  },
  {
    title: "Invite your team",
    why: "Give packers, agents and managers their own sign-in, with only what they need.",
    teamOnly: true,
    done: (p) => p.team,
    actions: () => [{ label: "Invite", to: "/settings/members" }],
  },
  {
    title: "Turn on the recommended messages",
    why: "Order confirmations, cash-on-delivery checks and cart reminders go out by themselves.",
    // They are sent over WhatsApp, which a "Just me" workspace can't connect.
    teamOnly: true,
    done: (p) => p.automations,
    actions: () => [{ label: "Turn on", to: "/campaigns/automations" }],
  },
];

/**
 * "Get your store live" on the owner's dashboard: the first jobs of a new
 * store, each ticked off by the workspace's own data (GET /dashboard/setup),
 * with a link to do it. Owners and admins see it until every step is done or
 * they hide it; Help and support brings it back.
 */
export function GetStartedCard({ className }: { className?: string }) {
  const { role } = useCurrentRole();
  const orgId = useAuthStore((s) => s.currentOrgId);
  const canSetUp = role === "OWNER" || role === "ADMIN";
  const [hidden, setHidden] = useState(() => readHidden(orgId));
  const { data } = useSetupProgress(canSetUp && !hidden);
  // Only the owner runs the setup wizard, and only they may read its progress.
  const { data: onboarding } = useOnboarding(role === "OWNER" ? orgId : null);
  const isPersonalWorkspace = useCurrentOrg().data?.type === "PERSONAL";

  useEffect(() => {
    const sync = () => setHidden(readHidden(orgId));
    sync();
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, [orgId]);

  // Setup was left part-way: the way back in comes before the checklist, and can't be hidden.
  if (onboarding?.status === "IN_PROGRESS") {
    const wizardSteps = onboardingSteps(onboarding.audience);
    const at = Math.max(wizardSteps.findIndex((step) => step.id === onboarding.progress.currentStep), 0);
    return (
      <SectionCard
        className={className}
        title="Finish setting up your workspace"
        description={`You're on step ${at + 1} of ${wizardSteps.length}: ${wizardSteps[at].title}. Everything so far is saved.`}
        action={
          <Button asChild size="sm">
            <Link to="/onboarding">Resume setup</Link>
          </Button>
        }
      >
        <div className="px-5 py-4" aria-hidden>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-success" style={{ width: `${((at + 1) / wizardSteps.length) * 100}%` }} />
          </div>
        </div>
      </SectionCard>
    );
  }

  if (!canSetUp || hidden || !data || !orgId) return null;
  const STEPS = SETUP_STEPS.filter((step) => !(step.teamOnly && isPersonalWorkspace));
  const done = STEPS.filter((step) => step.done(data)).length;
  if (done === STEPS.length) return null;

  return (
    <SectionCard
      className={className}
      title="Get your store live"
      description={`${done} of ${STEPS.length} done. Each step ticks itself off once it's set up.`}
      action={
        <Button variant="ghost" size="icon-sm" aria-label="Hide the setup guide" title="Hide the setup guide" onClick={() => writeHidden(orgId, true)}>
          <X />
        </Button>
      }
    >
      <div className="px-5 pt-4" aria-hidden>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success" style={{ width: `${(done / STEPS.length) * 100}%` }} />
        </div>
      </div>
      <ol className="divide-y divide-border/70 pb-1">
        {STEPS.map((step) => {
          const complete = step.done(data);
          const actions = step.actions(data).filter((a): a is { label: string; to: string } => !!a);
          return (
            <li key={step.title} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
              {complete ? (
                <CheckCircle2 className="size-5 shrink-0 text-success" aria-label="Done" />
              ) : (
                <Circle className="size-5 shrink-0 text-muted-foreground" aria-label="To do" />
              )}
              <div className="min-w-0 flex-1 basis-56">
                <p className={cn("text-body font-medium", complete && "text-muted-foreground line-through")}>{step.title}</p>
                {!complete && <p className="text-caption text-muted-foreground">{step.why}</p>}
              </div>
              {!complete && (
                <div className="flex flex-wrap gap-2 max-sm:pl-8">
                  {actions.map((action) => (
                    <Button key={action.label} asChild variant="outline" size="sm">
                      <Link to={action.to}>{action.label}</Link>
                    </Button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </SectionCard>
  );
}
