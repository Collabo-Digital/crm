import { useState } from "react";
import { CreditCard, Loader2 } from "lucide-react";

import { IntervalToggle } from "~/components/billing/plan-cards";
import { buyable, mandateNote, priceFor } from "~/lib/plan-pricing";
import { cn } from "~/lib/utils";
import type { BillingCurrency, BillingInterval, BillingPlan, BillingPlansResponse } from "~/types/api";

/**
 * "Already spoken to us?": pick the plan agreed after the demo, monthly or
 * yearly, and pay for it with Razorpay. Used in onboarding and in Settings →
 * Billing (owners only); the plan cards themselves only book demos.
 */
export function SubscribePicker({
  catalog,
  currency,
  busy,
  onPay,
}: {
  catalog: BillingPlansResponse;
  currency: BillingCurrency;
  busy: boolean;
  onPay: (plan: BillingPlan, interval: BillingInterval) => void;
}) {
  const plans = catalog.plans.filter((p) => p.selfServe);
  const [planId, setPlanId] = useState<BillingPlan>(plans.find((p) => p.highlighted)?.id ?? plans[0]?.id ?? "BASIC");
  const [interval, setBillingInterval] = useState<BillingInterval>("YEARLY");
  const plan = plans.find((p) => p.id === planId) ?? null;
  const canPay = !!plan && buyable(catalog, plan, interval, currency);
  const note = plan ? mandateNote(plan, interval, currency, catalog.gstPercent) : null;

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Plan agreed" className="flex flex-wrap gap-2">
        {plans.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={planId === p.id}
            onClick={() => setPlanId(p.id)}
            className={cn(
              "min-h-10 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
              planId === p.id ? "border-[#084734] bg-[#CEF17B]/30 text-foreground dark:border-[#CEF17B]" : "border-input text-muted-foreground hover:text-foreground",
            )}
          >
            {p.name}
          </button>
        ))}
      </div>
      <IntervalToggle value={interval} onChange={setBillingInterval} monthsFree={catalog.yearlyMonthsFree} />
      {plan && (
        <p className="text-sm text-foreground">
          {plan.name}, {priceFor(plan, interval, currency, catalog.gstPercent)}
        </p>
      )}
      {note && <p className="text-caption text-muted-foreground">{note}</p>}
      {plan && !canPay && (
        <p className="text-caption text-muted-foreground">
          {plan.name} cannot be paid {interval === "YEARLY" ? "yearly" : "monthly"} in {currency === "INR" ? "rupees" : "dollars"} here yet. Ask us for a payment link.
        </p>
      )}
      <button
        type="button"
        onClick={() => plan && onPay(plan.id, interval)}
        disabled={!canPay || busy}
        className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-input bg-background px-4 py-2 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CreditCard className="size-4" aria-hidden />}
        Pay with Razorpay
      </button>
    </div>
  );
}
