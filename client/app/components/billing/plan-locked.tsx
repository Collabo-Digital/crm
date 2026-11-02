import { CalendarCheck, Lock } from "lucide-react";

import { useBillingPlans } from "~/hooks/use-billing";
import { demoHref } from "~/lib/plan-pricing";
import { cn } from "~/lib/utils";
import type { PlanGate } from "~/types/api";

const WHAT: Record<PlanGate, string> = {
  packing: "The packing assistant",
  messagingAnalytics: "Team performance and messaging analytics",
  publicApi: "Making API keys and webhooks",
  storeScoping: "Limiting managers and staff to chosen stores",
};

/** In place of a feature the plan does not have: what it is, the plan that has it, and a way to a demo. */
export function PlanLocked({ gate, className }: { gate: PlanGate; className?: string }) {
  const { data: catalog } = useBillingPlans();
  const planId = catalog?.gatePlans[gate];
  const planName = catalog?.plans.find((p) => p.id === planId)?.name ?? (gate === "storeScoping" ? "Unlimited" : "Growth");
  const href = catalog ? demoHref(catalog, `Collabo ${planName} demo`) : null;
  return (
    <section role="status" className={cn("mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl bg-card px-6 py-8 text-center shadow-sm ring-1 ring-border", className)}>
      <span className="grid size-10 place-items-center rounded-xl bg-muted">
        <Lock className="size-4 text-muted-foreground" aria-hidden />
      </span>
      <p className="text-sm font-semibold text-foreground">Available on {planName}. Book a demo.</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{WHAT[gate]} is part of {planName} and above. Your data and everything else keep working as they are.</p>
      {href && (
        <a
          href={href}
          {...(href.startsWith("https:") ? { target: "_blank", rel: "noreferrer" } : {})}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[#CEF17B] px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-[#BADE6F]"
        >
          <CalendarCheck className="size-4" aria-hidden /> Book a demo
        </a>
      )}
    </section>
  );
}
