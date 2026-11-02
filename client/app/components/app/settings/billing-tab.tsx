import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CreditCard, ExternalLink, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { CurrencyToggle, PlanCards } from "~/components/billing/plan-cards";
import { SubscribePicker } from "~/components/billing/subscribe-picker";
import { billingKeys, useBillingPlans, useBillingUsage } from "~/hooks/use-billing";
import { useSubscribeMutation } from "~/hooks/use-billing-mutations";
import { useCurrentRole } from "~/hooks/use-current-role";
import { orgKeys } from "~/hooks/use-org-queries";
import { EVERY_PLAN_NOTE, formatCount, formatMinor, formatPrice, priceFor } from "~/lib/plan-pricing";
import { formatDate } from "~/lib/format-date";
import { loadScript } from "~/lib/load-script";
import { cn } from "~/lib/utils";
import { platformOffered } from "~/lib/channel-providers";
import { STATUS_TONE_CLASSES } from "~/lib/status-tone";
import { billingService } from "~/services/billing.service";
import { useAuthStore } from "~/stores/auth.store";
import type {
  BillingCurrency,
  BillingInterval,
  BillingPlan,
  BillingPlansResponse,
  BillingUsageSummary,
  PlanAllowance,
  PricingPlan,
  SubscriptionStatus,
  UsageBill,
  UsageBillStatus,
  UsageChargeLine,
} from "~/types/api";

/** The tab's icon, so Settings needs no icon import of its own. */
export const BillingIcon = CreditCard;

const RAZORPAY_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

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
  callingMinutes: "Calling minutes over the plan",
  members: "Extra team members",
  opsSeats: "Packing and till staff",
  storeLocations: "Extra stores",
  whatsappNumbers: "Extra WhatsApp numbers",
};

const LIVE: Array<SubscriptionStatus | null> = ["ACTIVE", "AUTHENTICATED"];

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
function Meter({ label, used, allowance, currency, unit, note, of = "included" }: { label: string; used: number; allowance: PlanAllowance | null; currency: BillingCurrency; unit: string; note?: string; of?: string }) {
  const included = allowance?.included ?? null;
  const over = included !== null ? Math.max(0, used - included) : 0;
  const share = included ? Math.min(1, used / included) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{formatCount(used, currency)}</span>
          {included !== null ? ` of ${formatCount(included, currency)} ${of}` : allowance ? " · unlimited" : ""}
        </span>
      </div>
      {included !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className={cn("h-full rounded-full", over ? "bg-warning" : "bg-[#084734] dark:bg-[#CEF17B]")} style={{ width: `${Math.max(share * 100, used ? 2 : 0)}%` }} />
        </div>
      )}
      {over > 0 && allowance?.fee && (
        <p className="text-caption text-warning-strong">
          {formatCount(over, currency)} {unit} over, at {formatPrice(allowance.fee[currency], currency)} each
        </p>
      )}
      {note && <p className="text-caption text-muted-foreground">{note}</p>}
    </div>
  );
}

function UsageMeters({ usage, plan, currency }: { usage: BillingUsageSummary["usage"]; plan: PricingPlan | null; currency: BillingCurrency }) {
  const seatsLeft = plan?.members.included != null ? Math.max(0, plan.members.included - usage.members) : null;
  const opsNote = !plan || plan.members.included === null
    ? "Agents who only pack, pick, receive, dispatch or use the till."
    : plan.opsSeat
      ? `Agents who only pack, pick, receive, dispatch or use the till. ${seatsLeft ? `They use your ${formatCount(seatsLeft, currency)} free team ${seatsLeft === 1 ? "seat" : "seats"} first, then` : "Each is"} ${formatPrice(plan.opsSeat[currency], currency)} a month.`
      : "Agents who only pack, pick, receive, dispatch or use the till.";
  const fairUse = plan?.fairUseChats != null ? { included: plan.fairUseChats, fee: null } : null;
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      <Meter
        label="Chats"
        used={usage.conversations}
        allowance={fairUse}
        of="under fair use"
        currency={currency}
        unit="chats"
        note={fairUse ? "Chats are unlimited and never charged. Well above fair use, we'll talk to you about a custom plan." : undefined}
      />
      <Meter label="WhatsApp calling minutes" used={usage.callingMinutes} allowance={plan?.callingMinutes ?? null} currency={currency} unit="minutes" />
      <Meter label="Team members" used={usage.members} allowance={plan?.members ?? null} currency={currency} unit="members" />
      <Meter label="Packing and till staff" used={usage.opsSeats} allowance={null} currency={currency} unit="staff" note={opsNote} />
      <Meter label="Stores with POS" used={usage.storeLocations} allowance={plan?.storeLocations ?? null} currency={currency} unit="stores" />
      <Meter label="WhatsApp numbers" used={usage.whatsappNumbers} allowance={plan?.whatsappNumbers ?? null} currency={currency} unit="numbers" />
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

/** The plan, and where the workspace stands: trial, payment needed, read-only. */
function PlanStatus({ summary, catalog }: { summary: BillingUsageSummary; catalog: BillingPlansResponse | undefined }) {
  const { access, subscription: sub } = summary;
  const plan = catalog?.plans.find((p) => p.id === (sub?.plan ?? summary.plan)) ?? null;
  const price = sub && plan ? priceFor(plan, sub.interval ?? "MONTHLY", sub.currency, catalog?.gstPercent ?? 18) : null;
  const alert =
    access.state === "grace"
      ? `Payment needed. The workspace turns read-only on ${formatDate(access.readOnlyFrom)}.`
      : access.state === "expired"
        ? "Read-only until a plan is active: sending, broadcasts, automations, new sales and edits are stopped. Incoming messages and orders are still saved."
        : null;
  return (
    <div className="space-y-3">
      {sub && plan ? (
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-base font-bold text-foreground">{plan.name}</p>
            <p className="text-xs text-muted-foreground">
              {sub.manual
                ? "Set up and invoiced by the Collabo team"
                : `${sub.status ? SUBSCRIPTION_STATUS[sub.status] : ""}${sub.currentPeriodEnd && sub.status === "ACTIVE" ? ` · renews ${formatDate(sub.currentPeriodEnd)}` : ""}`}
            </p>
          </div>
          {price && <p className="text-sm text-foreground">{price}</p>}
        </div>
      ) : access.state === "trialing" ? (
        <div>
          <p className="text-base font-bold text-foreground">{plan?.name ?? "Free trial"} · free trial</p>
          <p className="text-xs text-muted-foreground">
            Your trial ends on {formatDate(access.trialEndsAt)}, in {access.daysLeft} {access.daysLeft === 1 ? "day" : "days"}. Choose a plan below to keep everything working after it.
          </p>
        </div>
      ) : access.enforced ? (
        <p className="text-sm text-muted-foreground">This workspace has no plan. Choose one below.</p>
      ) : (
        <p className="text-sm text-muted-foreground">This workspace isn't on a paid plan yet. This month's usage is below; nothing is charged for it.</p>
      )}
      {alert && (
        <p role="status" className={cn("flex items-start gap-2 rounded-lg px-3 py-2 text-xs", STATUS_TONE_CLASSES[access.state === "expired" ? "critical" : "attention"])}>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{alert}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Settings → Billing: the plan and where the workspace stands, this month's
 * usage against it, the plans monthly or yearly in rupees or dollars, and the
 * usage bills. Owners and admins see it; only the owner chooses a plan.
 */
export function BillingTab({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const { role } = useCurrentRole();
  const user = useAuthStore((s) => s.user);
  const { data: catalog } = useBillingPlans();
  const { data: summary, isLoading, isError } = useBillingUsage(orgId);
  const subscribe = useSubscribeMutation();
  const [chosenCurrency, setChosenCurrency] = useState<BillingCurrency | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [paying, setPaying] = useState(false);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading billing…</p>;
  if (isError || !summary) return <p className="text-sm text-muted-foreground">Billing could not be loaded. Refresh to try again.</p>;

  const sub = summary.subscription;
  // Usage is in the currency the workspace pays in; the switch is for comparing plans.
  const currency = sub?.currency ?? "INR";
  const planCurrency = chosenCurrency ?? currency;
  const planOf = (id: BillingPlan) => catalog?.plans.find((p) => p.id === id) ?? null;
  // The allowances the meters show: the plan paid for, or the trial's.
  const meterPlan = sub ? planOf(sub.plan) : summary.access.enforced ? planOf(summary.plan) : null;
  const live = !!sub && !sub.manual && LIVE.includes(sub.status);
  const isOwner = role === "OWNER";
  const canChoose = isOwner && !live && !sub?.manual;
  const estimate = summary.estimate;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: billingKeys.usage(orgId) });
    void queryClient.invalidateQueries({ queryKey: orgKeys.detail(orgId) });
  };

  /** Razorpay's success callback is not proof of payment: the webhook is. Asks until the server has it. */
  async function waitUntilPaid(): Promise<boolean> {
    for (let i = 0; i < 15; i++) {
      const latest = await billingService.getUsage().catch(() => null);
      if (latest?.subscription && LIVE.includes(latest.subscription.status)) return true;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return false;
  }

  async function pay(planId: BillingPlan, interval: BillingInterval) {
    const pickedPlan = planOf(planId);
    if (!pickedPlan) return;
    setPaying(true);
    const loaded = loadScript(RAZORPAY_SCRIPT_URL).then(() => true, () => false);
    // The mutation says why it failed itself.
    const checkout = await subscribe.mutateAsync({ billingPlan: pickedPlan.id, billingInterval: interval, currency: planCurrency }).catch(() => null);
    if (!checkout) {
      setPaying(false);
      return;
    }
    if (!checkout.razorpayKeyId || !(await loaded)) {
      toast.error(checkout.razorpayKeyId ? "The payment window could not be loaded. Check your connection and try again." : "Billing is not set up yet. Email support.");
      setPaying(false);
      return;
    }
    new window.Razorpay({
      key: checkout.razorpayKeyId,
      subscription_id: checkout.subscriptionId,
      name: "Collabo",
      description: `${pickedPlan.name} plan, paid ${interval === "YEARLY" ? "yearly" : "monthly"}`,
      prefill: { name: `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim(), email: user?.email ?? "" },
      theme: { color: "#CEF17B" },
      handler: () => {
        void waitUntilPaid().then((paid) => {
          refresh();
          setPaying(false);
          if (paid) toast.success(`You're on ${pickedPlan.name}.`);
          else toast.warning("Your payment is still being confirmed. This page updates once Razorpay confirms it.");
        });
      },
      modal: {
        ondismiss: () => {
          setPaying(false);
          refresh();
        },
      },
    }).open();
  }

  const monthHelp = sub?.manual
    ? "Usage over your plan is invoiced by the Collabo team after the month ends."
    : live
      ? "Usage over your plan is billed after the month ends: added to your next invoice when you pay monthly by card, otherwise sent as a payment link."
      : summary.access.state === "trialing"
        ? "Nothing is charged during the trial."
        : undefined;

  return (
    <div className="space-y-5">
      <Card title="Your plan">
        <PlanStatus summary={summary} catalog={catalog} />
      </Card>

      <Card title={`${monthName(summary.period)} so far`} help={monthHelp}>
        <UsageMeters usage={summary.usage} plan={meterPlan?.price ? meterPlan : null} currency={currency} />
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
        <Card title="Plans" help={EVERY_PLAN_NOTE} action={<CurrencyToggle value={planCurrency} onChange={setChosenCurrency} />}>
          <PlanCards catalog={catalog} currency={planCurrency} current={sub ? sub.plan : summary.access.state === "trialing" ? summary.plan : null} />
          <div className="mt-5 border-t pt-4 text-xs text-muted-foreground">
            {canChoose ? (
              subscribing ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-foreground">Already spoken to us? Subscribe</p>
                  <SubscribePicker catalog={catalog} currency={planCurrency} busy={paying} onPay={(plan, interval) => void pay(plan, interval)} />
                </div>
              ) : (
                <button type="button" onClick={() => setSubscribing(true)} className="min-h-10 font-semibold text-foreground underline underline-offset-2">
                  Already spoken to us? Subscribe
                </button>
              )
            ) : live || sub?.manual ? (
              catalog.salesEmail ? (
                <a href={`mailto:${catalog.salesEmail}?subject=${encodeURIComponent("Change my Collabo plan")}`} className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline">
                  <Mail className="size-3.5" aria-hidden /> To change your plan, talk to us
                </a>
              ) : (
                <span>To change your plan, talk to your Collabo contact.</span>
              )
            ) : (
              <span>Only the workspace owner can choose a plan.</span>
            )}
          </div>
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
