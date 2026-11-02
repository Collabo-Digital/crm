import { CalendarCheck, Check, Mail, Sparkles } from "lucide-react";

import { cn } from "~/lib/utils";
import { billingLine, buyable, formatPrice, monthlyPrice, planBullets } from "~/lib/plan-pricing";
import type { BillingCurrency, BillingInterval, BillingPlan, BillingPlansResponse, PricingPlan } from "~/types/api";
import { platformOffered } from "~/lib/channel-providers";

export { formatCount, formatMinor, formatPrice, PRICING_NOTE } from "~/lib/plan-pricing";

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
export function IntervalToggle({ value, onChange, discountPercent }: { value: BillingInterval; onChange: (interval: BillingInterval) => void; discountPercent: number }) {
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
              Yearly <span className="ml-1 rounded bg-[#CEF17B] px-1 py-px text-micro font-semibold text-gray-900">{discountPercent}% off</span>
            </>
          ),
        },
        { value: "MONTHLY", label: "Monthly" },
      ]}
    />
  );
}

interface PlanCardsProps {
  catalog: BillingPlansResponse;
  currency: BillingCurrency;
  interval: BillingInterval;
  /** Choose-plan and Settings: the plan picked for checkout. */
  selected?: BillingPlan | null;
  /** Settings: the plan the workspace is on. */
  current?: BillingPlan | null;
  /** Makes the plans bought at checkout pickable. */
  onSelect?: (plan: BillingPlan) => void;
  className?: string;
}

export function PlanCards({ catalog, currency, interval, selected, current, onSelect, className }: PlanCardsProps) {
  return (
    <div
      role={onSelect ? "radiogroup" : undefined}
      aria-label={onSelect ? "Plan" : undefined}
      className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}
    >
      {catalog.plans.map((plan) => {
        const canBuy = buyable(catalog, plan, interval, currency);
        return (
          <PlanCard
            key={plan.id}
            plan={plan}
            currency={currency}
            interval={interval}
            gstPercent={catalog.gstPercent}
            salesEmail={catalog.salesEmail}
            selected={selected === plan.id}
            current={current === plan.id}
            unavailable={!!onSelect && plan.selfServe && !canBuy}
            onSelect={onSelect && canBuy ? () => onSelect(plan.id) : undefined}
          />
        );
      })}
    </div>
  );
}

interface PlanCardProps {
  plan: PricingPlan;
  currency: BillingCurrency;
  interval: BillingInterval;
  gstPercent: number;
  salesEmail: string | null;
  selected: boolean;
  current: boolean;
  unavailable: boolean;
  onSelect?: () => void;
}

/** Scale is sold after a demo, Enterprise on a contract: both by writing to the Collabo team. */
function SalesLink({ plan, salesEmail }: { plan: PricingPlan; salesEmail: string | null }) {
  if (!salesEmail) return <p className="mt-auto text-xs text-muted-foreground">Talk to your Collabo contact to set it up.</p>;
  const demo = plan.sales === "demo";
  const Icon = demo ? CalendarCheck : Mail;
  return (
    <a
      href={`mailto:${salesEmail}?subject=${encodeURIComponent(demo ? `Collabo ${plan.name} demo` : `Collabo ${plan.name}`)}`}
      className="mt-auto inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-input px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
    >
      <Icon className="size-3.5" aria-hidden /> {demo ? "Book a demo" : "Talk to us"}
    </a>
  );
}

function PlanCard({ plan, currency, interval, gstPercent, salesEmail, selected, current, unavailable, onSelect }: PlanCardProps) {
  const price = monthlyPrice(plan, interval, currency);
  const billed = billingLine(plan, interval, currency, gstPercent);
  const bullets = planBullets(plan, currency, { instagram: platformOffered("INSTAGRAM"), messenger: platformOffered("FACEBOOK") });
  const body = (
    <>
      {plan.highlighted && (
        <span className="absolute -top-2.5 right-5 inline-flex items-center gap-1 rounded-full bg-[#084734] px-2.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-[#CEF17B]">
          <Sparkles className="size-3" aria-hidden />
          Popular
        </span>
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-foreground">{plan.name}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{plan.tagline}</p>
        </div>
        {current && (
          <span className="shrink-0 rounded-full bg-[#CEF17B]/40 px-2 py-0.5 text-micro font-semibold text-[#084734] dark:text-[#CEF17B]">Your plan</span>
        )}
      </div>

      {price !== null ? (
        <div>
          <p className="flex items-baseline gap-1">
            <span className="text-2xl font-bold text-foreground">{formatPrice(price, currency)}</span>
            <span className="text-sm text-muted-foreground">/month</span>
          </p>
          <p className="text-caption text-muted-foreground">{billed}</p>
        </div>
      ) : (
        <div>
          <p className="text-2xl font-bold text-foreground">Custom</p>
          <p className="text-caption text-muted-foreground">Priced for your volume</p>
        </div>
      )}

      <ul className="space-y-1.5">
        {bullets.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-xs text-foreground/80">
            <Check className="mt-0.5 size-3.5 shrink-0 text-[#084734] dark:text-[#CEF17B]" aria-hidden />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {!plan.selfServe && <SalesLink plan={plan} salesEmail={salesEmail} />}
      {unavailable && (
        <p className="mt-auto text-xs text-muted-foreground">
          Not available {interval === "YEARLY" ? "yearly" : "monthly"} in {currency === "INR" ? "rupees" : "dollars"} yet.
        </p>
      )}
    </>
  );

  const frame = cn(
    "relative flex h-full flex-col gap-4 rounded-2xl border-2 bg-card p-5 text-left shadow-sm",
    selected ? "border-[#CEF17B] shadow-md" : current ? "border-[#CEF17B]/60" : "border-transparent ring-1 ring-border",
  );
  if (!onSelect) return <div className={cn(frame, unavailable && "opacity-60")}>{body}</div>;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(frame, "transition-all hover:border-[#CEF17B] hover:shadow-md focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
    >
      {body}
    </button>
  );
}
