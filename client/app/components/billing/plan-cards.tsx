import { Check, Mail, Sparkles } from "lucide-react";

import { cn, formatCurrency } from "~/lib/utils";
import type { BillingCurrency, BillingPlan, BillingPlansResponse, Money, PricingPlan } from "~/types/api";

/** Rupees as read in India (₹1,00,000), dollars as in the US ($59, not US$59). */
const LOCALE: Record<BillingCurrency, string> = { INR: "en-IN", USD: "en-US" };

/** Whole amounts without decimals (₹5,000); fees to four places ($0.0024). */
export function formatPrice(amount: number, currency: BillingCurrency): string {
  const locale = LOCALE[currency];
  return Number.isInteger(amount)
    ? formatCurrency(amount, currency, { maximumFractionDigits: 0, locale })
    : formatCurrency(amount, currency, { minimumFractionDigits: 2, maximumFractionDigits: 4, locale });
}

/** An amount in paise or cents. */
export function formatMinor(amount: number, currency: BillingCurrency): string {
  return formatCurrency(amount / 100, currency, { locale: LOCALE[currency] });
}

export function formatCount(n: number, currency: BillingCurrency): string {
  return n.toLocaleString(LOCALE[currency]);
}

export const PRICING_NOTE =
  "Every plan has every feature. A conversation is 24 hours of WhatsApp messages with one customer, starting with the first message either way. Usage over your plan is billed after each month ends. WhatsApp's own message charges are paid to Meta directly, at Meta's rates.";

export function planFeatures(plan: PricingPlan, currency: BillingCurrency): string[] {
  const n = (v: number) => formatCount(v, currency);
  const fee = (m: Money) => formatPrice(m[currency], currency);
  const { conversations, members, callingMinutes } = plan;
  return [
    conversations.included === null || !conversations.fee
      ? "No conversation fee"
      : `${n(conversations.included)} conversations a month, then ${fee(conversations.fee)} each`,
    members.included === null || !members.fee
      ? "Unlimited team members"
      : `${n(members.included)} team members, then ${fee(members.fee)} a month each`,
    callingMinutes.fee && callingMinutes.included !== null
      ? `${n(callingMinutes.included)} WhatsApp calling minutes, then ${fee(callingMinutes.fee)} a minute`
      : `${n(callingMinutes.included ?? 0)}+ WhatsApp calling minutes`,
    plan.instagram ? `Instagram: ${fee(plan.instagram)} a month per account` : "Instagram included",
    "Messenger included",
  ];
}

export function CurrencyToggle({ value, onChange }: { value: BillingCurrency; onChange: (currency: BillingCurrency) => void }) {
  return (
    <div role="radiogroup" aria-label="Currency" className="inline-flex rounded-lg bg-muted p-0.5 text-xs font-medium">
      {(["INR", "USD"] as const).map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          onClick={() => onChange(c)}
          className={cn(
            "rounded-md px-3 py-1 transition-colors",
            value === c ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {c === "INR" ? "₹ Rupees" : "$ Dollars"}
        </button>
      ))}
    </div>
  );
}

interface PlanCardsProps {
  catalog: BillingPlansResponse;
  currency: BillingCurrency;
  /** Choose-plan: the plan picked for checkout. */
  selected?: BillingPlan | null;
  /** Settings: the plan the workspace is on. */
  current?: BillingPlan | null;
  /** Makes the self-serve plans pickable. */
  onSelect?: (plan: BillingPlan) => void;
}

export function PlanCards({ catalog, currency, selected, current, onSelect }: PlanCardsProps) {
  return (
    <div role={onSelect ? "radiogroup" : undefined} aria-label={onSelect ? "Plan" : undefined} className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {catalog.plans.map((plan) => {
        const buyable = plan.selfServe && (catalog.checkout[plan.id] ?? []).includes(currency);
        return (
          <PlanCard
            key={plan.id}
            plan={plan}
            currency={currency}
            gstPercent={catalog.gstPercent}
            salesEmail={catalog.salesEmail}
            selected={selected === plan.id}
            current={current === plan.id}
            unavailable={!!onSelect && plan.selfServe && !buyable}
            onSelect={onSelect && buyable ? () => onSelect(plan.id) : undefined}
          />
        );
      })}
    </div>
  );
}

interface PlanCardProps {
  plan: PricingPlan;
  currency: BillingCurrency;
  gstPercent: number;
  salesEmail: string | null;
  selected: boolean;
  current: boolean;
  unavailable: boolean;
  onSelect?: () => void;
}

function PlanCard({ plan, currency, gstPercent, salesEmail, selected, current, unavailable, onSelect }: PlanCardProps) {
  const body = (
    <>
      {plan.highlighted && (
        <span className="absolute -top-2.5 right-5 inline-flex items-center gap-1 rounded-full bg-[#084734] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#CEF17B]">
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
          <span className="shrink-0 rounded-full bg-[#CEF17B]/40 px-2 py-0.5 text-[10px] font-semibold text-[#084734] dark:text-[#CEF17B]">Your plan</span>
        )}
      </div>

      {plan.price ? (
        <div>
          <p className="flex items-baseline gap-1">
            <span className="text-2xl font-bold text-foreground">{formatPrice(plan.price[currency], currency)}</span>
            <span className="text-sm text-muted-foreground">/month</span>
          </p>
          <p className="text-[11px] text-muted-foreground">{currency === "INR" ? `+ ${gstPercent}% GST` : "Billed in US dollars"}</p>
        </div>
      ) : (
        <div>
          <p className="text-2xl font-bold text-foreground">Custom</p>
          <p className="text-[11px] text-muted-foreground">Priced for your volume</p>
        </div>
      )}

      <ul className="space-y-1.5">
        {planFeatures(plan, currency).map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-xs text-foreground/80">
            <Check className="mt-0.5 size-3.5 shrink-0 text-[#084734] dark:text-[#CEF17B]" aria-hidden />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {!plan.selfServe && (
        salesEmail ? (
          <a
            href={`mailto:${salesEmail}?subject=${encodeURIComponent("Collabo Enterprise")}`}
            className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg border border-input px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Mail className="size-3.5" aria-hidden /> Talk to us
          </a>
        ) : (
          <p className="mt-auto text-xs text-muted-foreground">Talk to your Collabo contact to set it up.</p>
        )
      )}
      {unavailable && <p className="mt-auto text-xs text-muted-foreground">Not available in {currency === "INR" ? "rupees" : "dollars"} yet.</p>}
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
      className={cn(frame, "transition-all hover:border-[#CEF17B] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#CEF17B]/60")}
    >
      {body}
    </button>
  );
}
