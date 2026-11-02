import { useState } from "react";
import { CreditCard, ExternalLink } from "lucide-react";

import { CurrencyToggle, formatCount, formatMinor, formatPrice, PlanCards, PRICING_NOTE } from "~/components/billing/plan-cards";
import { useBillingPlans, useBillingUsage } from "~/hooks/use-billing";
import { formatDate } from "~/lib/format-date";
import { cn } from "~/lib/utils";
import type { BillingCurrency, BillingUsage, PlanAllowance, PricingPlan, SubscriptionStatus, UsageBill, UsageBillStatus, UsageChargeLine } from "~/types/api";
import { platformOffered } from "~/lib/channel-providers";

/** The tab's icon, so Settings needs no icon import of its own. */
export const BillingIcon = CreditCard;

const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, string> = {
  CREATED: "Awaiting payment",
  AUTHENTICATED: "Starting",
  ACTIVE: "Active",
  PAUSED: "Paused",
  HALTED: "Payment failed",
  CANCELLED: "Cancelled",
  COMPLETED: "Ended",
  EXPIRED: "Expired",
};

const BILL_STATUS: Record<UsageBillStatus, string> = {
  PROCESSING: "Being billed",
  NOTHING_DUE: "Nothing over your plan",
  ADDED: "On your next invoice",
  LINK_SENT: "Payment link sent",
  PAID: "Paid",
  SKIPPED: "Not billed",
  FAILED: "Not billed yet",
};

const LINE_LABEL: Record<UsageChargeLine["key"], string> = {
  conversations: "Conversations over the plan",
  callingMinutes: "Calling minutes over the plan",
  members: "Extra team members",
  instagram: "Instagram accounts",
};

function monthName(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function Card({ title, help, action, children }: { title: string; help?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-card shadow-sm ring-1 ring-border">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {help && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{help}</p>}
        </div>
        {action}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/** One measure of this month's usage, against the plan's allowance when there is one. */
function Meter({ label, used, allowance, currency, unit }: { label: string; used: number; allowance: PlanAllowance | null; currency: BillingCurrency; unit: string }) {
  const included = allowance?.included ?? null;
  const over = included !== null ? Math.max(0, used - included) : 0;
  const share = included ? Math.min(1, used / included) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{formatCount(used, currency)}</span>
          {included !== null ? ` of ${formatCount(included, currency)} included` : allowance ? " · unlimited" : ""}
        </span>
      </div>
      {included !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className={cn("h-full rounded-full", over ? "bg-warning" : "bg-[#084734] dark:bg-[#CEF17B]")} style={{ width: `${Math.max(share * 100, used ? 2 : 0)}%` }} />
        </div>
      )}
      {over > 0 && allowance?.fee && (
        <p className="text-[11px] text-warning-strong">
          {formatCount(over, currency)} {unit} over, at {formatPrice(allowance.fee[currency], currency)} each
        </p>
      )}
    </div>
  );
}

function UsageMeters({ usage, plan, currency }: { usage: BillingUsage; plan: PricingPlan | null; currency: BillingCurrency }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      <Meter label="Conversations" used={usage.conversations} allowance={plan?.conversations ?? null} currency={currency} unit="conversations" />
      <Meter label="WhatsApp calling minutes" used={usage.callingMinutes} allowance={plan?.callingMinutes ?? null} currency={currency} unit="minutes" />
      <Meter label="Team members" used={usage.members} allowance={plan?.members ?? null} currency={currency} unit="members" />
      {(platformOffered("INSTAGRAM") || usage.instagramAccounts > 0) && (
        <Meter label="Instagram accounts" used={usage.instagramAccounts} allowance={null} currency={currency} unit="accounts" />
      )}
    </div>
  );
}

function BillRow({ bill }: { bill: UsageBill }) {
  const currency = bill.currency ?? "INR";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-xs">
      <span className="w-32 font-medium text-foreground">{monthName(bill.period)}</span>
      <span className="w-24 tabular-nums text-foreground">{bill.total !== null ? formatMinor(bill.total, currency) : "—"}</span>
      <span className="text-muted-foreground" title={bill.note ?? undefined}>
        {BILL_STATUS[bill.status]}
        {bill.status === "PAID" || bill.status === "ADDED" ? ` · ${formatDate(bill.updatedAt)}` : ""}
      </span>
      {bill.status === "LINK_SENT" && bill.paymentUrl && (
        <a href={bill.paymentUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 rounded-md bg-[#CEF17B] px-2.5 py-1 font-medium text-gray-900 hover:bg-[#BADE6F]">
          Pay <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </li>
  );
}

/**
 * Settings → Billing: the plan, this month's usage against it, the plans in
 * rupees or dollars, and the usage bills. Owners and admins only.
 */
export function BillingTab({ orgId }: { orgId: string }) {
  const { data: catalog } = useBillingPlans();
  const { data: summary, isLoading, isError } = useBillingUsage(orgId);
  const [chosen, setChosen] = useState<BillingCurrency | null>(null);
  // Usage is in the currency the workspace pays in; the switch is for comparing plans.
  const currency = summary?.subscription?.currency ?? "INR";
  const planCurrency = chosen ?? currency;

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading billing…</p>;
  if (isError || !summary) return <p className="text-sm text-muted-foreground">Billing could not be loaded. Refresh to try again.</p>;

  const sub = summary.subscription;
  const plan = sub ? catalog?.plans.find((p) => p.id === sub.plan) ?? null : null;
  const estimate = summary.estimate;

  return (
    <div className="space-y-5">
      <Card title="Your plan">
        {sub && plan ? (
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-base font-bold text-foreground">{plan.name}</p>
              <p className="text-xs text-muted-foreground">
                {SUBSCRIPTION_STATUS[sub.status]}
                {sub.currentPeriodEnd && sub.status === "ACTIVE" ? ` · renews ${formatDate(sub.currentPeriodEnd)}` : ""}
              </p>
            </div>
            {plan.price && (
              <p className="text-sm text-foreground">
                <span className="font-semibold">{formatPrice(plan.price[sub.currency], sub.currency)}</span>
                <span className="text-muted-foreground"> a month{sub.currency === "INR" ? ` + ${catalog?.gstPercent ?? 18}% GST` : ""}</span>
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This workspace isn't on a paid plan yet. This month's usage is below; nothing is charged for it.
          </p>
        )}
      </Card>

      <Card
        title={`${monthName(summary.period)} so far`}
        help={plan?.price ? "Usage over your plan is billed after the month ends: added to your next invoice when you pay by card, or sent as a payment link." : undefined}
      >
        <UsageMeters usage={summary.usage} plan={plan?.price ? plan : null} currency={currency} />
        {estimate && (
          <div className="mt-5 rounded-lg bg-muted/60 p-3 text-xs">
            {estimate.lines.length === 0 ? (
              <p className="text-muted-foreground">Nothing over your plan so far this month.</p>
            ) : (
              <dl className="space-y-1">
                {estimate.lines.map((l) => (
                  <div key={l.key} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{LINE_LABEL[l.key]} · {formatCount(l.quantity, currency)} × {formatPrice(l.unitPrice, currency)}</dt>
                    <dd className="tabular-nums text-foreground">{formatMinor(l.amount, currency)}</dd>
                  </div>
                ))}
                {estimate.tax > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">GST {catalog?.gstPercent ?? 18}%</dt>
                    <dd className="tabular-nums text-foreground">{formatMinor(estimate.tax, currency)}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-3 border-t pt-1 font-semibold">
                  <dt className="text-foreground">Over your plan so far</dt>
                  <dd className="tabular-nums text-foreground">{formatMinor(estimate.total, currency)}</dd>
                </div>
              </dl>
            )}
          </div>
        )}
      </Card>

      {catalog && (
        <Card title="Plans" help={PRICING_NOTE} action={<CurrencyToggle value={planCurrency} onChange={setChosen} />}>
          <PlanCards catalog={catalog} currency={planCurrency} current={sub ? sub.plan : null} />
        </Card>
      )}

      {summary.bills.length > 0 && (
        <Card title="Usage bills" help="Each month's usage over your plan, billed once the month is over.">
          <ul className="divide-y rounded-lg border">
            {summary.bills.map((b) => <BillRow key={b.id} bill={b} />)}
          </ul>
        </Card>
      )}
    </div>
  );
}
