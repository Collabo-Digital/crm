import { CalendarCheck, Check, Mail } from "lucide-react";

import { cn } from "~/lib/utils";
import { demoHref, FAIR_USE_NOTE, formatPrice, planBullets, planChannels, yearlyLine } from "~/lib/plan-pricing";
import type { BillingCurrency, BillingInterval, BillingPlan, BillingPlansResponse, PricingPlan } from "~/types/api";
import { platformOffered } from "~/lib/channel-providers";

export { formatCount, formatMinor, formatPrice, EVERY_PLAN_NOTE, FAIR_USE_NOTE } from "~/lib/plan-pricing";

function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: React.ReactNode }>; onChange: (value: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-muted p-0.5 text-xs font-medium">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1 transition-colors",
            value === o.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CurrencyToggle({ value, onChange }: { value: BillingCurrency; onChange: (currency: BillingCurrency) => void }) {
  return (
    <Toggle
      label="Currency"
      value={value}
      onChange={onChange}
      options={[
        { value: "INR", label: "₹ Rupees" },
        { value: "USD", label: "$ Dollars" },
      ]}
    />
  );
}

/** Yearly first: it is the better price. */
export function IntervalToggle({ value, onChange, monthsFree }: { value: BillingInterval; onChange: (interval: BillingInterval) => void; monthsFree: number }) {
  return (
    <Toggle
      label="Billing"
      value={value}
      onChange={onChange}
      options={[
        {
          value: "YEARLY",
          label: (
            <>
              Yearly <span className="ml-1 rounded bg-[#CEF17B] px-1 py-px text-micro font-semibold text-gray-900">{monthsFree} months free</span>
            </>
          ),
        },
        { value: "MONTHLY", label: "Monthly" },
      ]}
    />
  );
}

/** "Book a demo": the demo link when one is set, otherwise an email to the sales address. */
function DemoButton({ catalog, plan }: { catalog: BillingPlansResponse; plan: PricingPlan }) {
  const href = demoHref(catalog, `Collabo ${plan.name} demo`);
  if (!href) return <p className="mt-auto text-xs text-muted-foreground">Ask your Collabo contact for a demo.</p>;
  return (
    <a
      href={href}
      {...(href.startsWith("https:") ? { target: "_blank", rel: "noreferrer" } : {})}
      className={cn(
        "mt-auto inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition",
        plan.highlighted ? "bg-[#CEF17B] text-gray-900 hover:bg-[#BADE6F]" : "bg-[#084734] text-white hover:bg-[#0B5A43]",
      )}
    >
      <CalendarCheck className="size-4" aria-hidden /> Book a demo
    </a>
  );
}

interface PlanCardsProps {
  catalog: BillingPlansResponse;
  currency: BillingCurrency;
  /** Settings: the plan the workspace is on. */
  current?: BillingPlan | null;
  className?: string;
}

/**
 * The plans sold after a demo, as three cards, then Enterprise in a line and
 * the fair-use note. Choosing and paying is a separate step (SubscribePicker).
 */
export function PlanCards({ catalog, currency, current, className }: PlanCardsProps) {
  const cards = catalog.plans.filter((p) => p.sales === "demo");
  const enterprise = catalog.plans.find((p) => p.sales === "contract");
  const talk = catalog.salesEmail ? `mailto:${catalog.salesEmail}?subject=${encodeURIComponent("Collabo Enterprise")}` : demoHref(catalog, "Collabo Enterprise");
  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {cards.map((plan) => (
          <PlanCard key={plan.id} plan={plan} catalog={catalog} currency={currency} current={current === plan.id} />
        ))}
      </div>
      {enterprise && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl bg-card px-5 py-3 text-sm text-foreground shadow-sm ring-1 ring-border">
          <span className="font-semibold">Groups of brands?</span>
          {talk ? (
            <a href={talk} className="inline-flex items-center gap-1 font-semibold text-[#084734] underline underline-offset-2 dark:text-[#CEF17B]">
              <Mail className="size-3.5" aria-hidden /> Talk to us.
            </a>
          ) : (
            <span>Talk to your Collabo contact.</span>
          )}
          {current === enterprise.id && <span className="rounded-full bg-[#CEF17B]/40 px-2 py-0.5 text-micro font-semibold text-[#084734] dark:text-[#CEF17B]">Your plan: Enterprise</span>}
        </p>
      )}
      <p className="text-caption leading-relaxed text-muted-foreground">{FAIR_USE_NOTE}</p>
    </div>
  );
}

function PlanCard({ plan, catalog, currency, current }: { plan: PricingPlan; catalog: BillingPlansResponse; currency: BillingCurrency; current: boolean }) {
  const yearly = yearlyLine(plan, currency, catalog.yearlyMonthsFree);
  const channels = planChannels({ instagram: platformOffered("INSTAGRAM") });
  return (
    <div
      className={cn(
        "relative flex h-full flex-col gap-4 rounded-2xl border-2 bg-card p-5 text-left shadow-sm",
        plan.highlighted ? "border-[#CEF17B] shadow-md" : current ? "border-[#CEF17B]/60" : "border-transparent ring-1 ring-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-lg font-bold text-foreground">{plan.name}</h3>
        <div className="flex flex-wrap gap-1.5">
          {plan.badge && (
            <span className={cn("rounded-full px-2.5 py-0.5 text-micro font-semibold", plan.highlighted ? "bg-[#084734] text-[#CEF17B]" : "bg-muted text-foreground")}>{plan.badge}</span>
          )}
          {current && <span className="rounded-full bg-[#CEF17B]/40 px-2 py-0.5 text-micro font-semibold text-[#084734] dark:text-[#CEF17B]">Your plan</span>}
        </div>
      </div>
      <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">Best for {plan.bestFor}.</p>

      {plan.price && (
        <div>
          <p className="flex flex-wrap items-baseline gap-1">
            <span className="text-2xl font-bold text-foreground">{formatPrice(plan.price.MONTHLY[currency], currency)}</span>
            <span className="text-sm text-muted-foreground">{currency === "INR" ? "+ GST / month" : "/ month"}</span>
          </p>
          {yearly && <p className="text-caption text-muted-foreground">{yearly}</p>}
        </div>
      )}

      <ul className="flex flex-wrap gap-1.5" aria-label="Channels">
        {channels.map((c) => (
          <li key={c} className="rounded-full bg-muted px-2.5 py-0.5 text-caption font-medium text-foreground">{c}</li>
        ))}
      </ul>

      <ul className="space-y-1.5">
        {planBullets(plan, catalog, currency).map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-xs text-foreground/80">
            <Check className="mt-0.5 size-3.5 shrink-0 text-[#084734] dark:text-[#CEF17B]" aria-hidden />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <DemoButton catalog={catalog} plan={plan} />
    </div>
  );
}
