import type { BillingAccess, BillingCurrency, BillingInterval, BillingPlansResponse, Money, OrgResponse, PlanGate, PricingPlan } from "~/types/api";
import { formatDate } from "./format-date.ts";
import { formatCurrency } from "./utils.ts";

/**
 * Prices and plan copy for the plan cards, Settings → Billing, the locked
 * states and the app's billing banner. Plain functions with no React, so
 * `node --test` runs them.
 */

/** Rupees as read in India (₹1,00,000), dollars as in the US ($59, not US$59). */
const LOCALE: Record<BillingCurrency, string> = { INR: "en-IN", USD: "en-US" };

/** Whole amounts without decimals (₹8,999); fees to four places ($0.0024). */
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

export const FAIR_USE_NOTE =
  "Unlimited is subject to fair use, to keep the service fast for everyone. If your use looks like an API farm or replaces a call centre, we'll agree a custom plan.";

export const EVERY_PLAN_NOTE =
  "Every plan has GST invoices, the POS at your included stores, the shared inbox, broadcasts, automations, Shopify and orders. WhatsApp's own message charges are paid to Meta directly, at Meta's price, with no markup.";

/** "₹12,999 + GST / month", or "$159 / month". Null when priced per contract. */
export function monthlyLine(plan: PricingPlan, currency: BillingCurrency): string | null {
  if (!plan.price) return null;
  return `${formatPrice(plan.price.MONTHLY[currency], currency)}${currency === "INR" ? " + GST" : ""} / month`;
}

/** Under the monthly price: "or ₹1,29,990 a year, two months free". */
export function yearlyLine(plan: PricingPlan, currency: BillingCurrency, monthsFree: number): string | null {
  if (!plan.price) return null;
  const free = monthsFree === 2 ? "two months" : `${monthsFree} months`;
  return `or ${formatPrice(plan.price.YEARLY[currency], currency)} a year, ${free} free`;
}

/** What paying this way costs, with the tax: "₹1,29,990 a year + 18% GST". */
export function priceFor(plan: PricingPlan, interval: BillingInterval, currency: BillingCurrency, gstPercent: number): string | null {
  if (!plan.price) return null;
  const tax = currency === "INR" ? ` + ${gstPercent}% GST` : "";
  return `${formatPrice(plan.price[interval][currency], currency)} a ${interval === "YEARLY" ? "year" : "month"}${tax}`;
}

/** Card and UPI mandates need the customer's approval for each charge above this, in rupees, GST included. */
export const MANDATE_LIMIT_INR = 15_000;

/**
 * Next to a monthly subscription that costs more than the mandate limit with
 * GST: the customer's bank or UPI app asks them to approve each charge.
 */
export function mandateNote(plan: PricingPlan, interval: BillingInterval, currency: BillingCurrency, gstPercent: number): string | null {
  if (!plan.price || interval !== "MONTHLY" || currency !== "INR") return null;
  if (plan.price.MONTHLY.INR * (1 + gstPercent / 100) <= MANDATE_LIMIT_INR) return null;
  return "Above ₹15,000 a month with GST, your bank or UPI app asks you to approve each monthly charge. Pay yearly to avoid that, or ask us for a payment link.";
}

/** Can this plan be subscribed to, paid this way, in this currency? */
export function buyable(catalog: BillingPlansResponse, plan: PricingPlan, interval: BillingInterval, currency: BillingCurrency): boolean {
  return plan.selfServe && (catalog.checkout[plan.id]?.[interval] ?? []).includes(currency);
}

/** Where "Book a demo" goes: the demo link when set, otherwise an email to the sales address. */
export function demoHref(catalog: Pick<BillingPlansResponse, "demoUrl" | "salesEmail">, subject: string): string | null {
  if (catalog.demoUrl) return catalog.demoUrl;
  return catalog.salesEmail ? `mailto:${catalog.salesEmail}?subject=${encodeURIComponent(subject)}` : null;
}

/** The channels a plan card lists. Instagram only where the app offers it. */
export function planChannels(offered: { instagram: boolean }): string[] {
  return ["WhatsApp", ...(offered.instagram ? ["Instagram DM"] : []), "Website chat buttons"];
}

const GATE_TEXT: Record<PlanGate, string> = {
  packing: "Packing assistant",
  messagingAnalytics: "Team performance and messaging analytics",
  publicApi: "Public API and webhooks",
  storeScoping: "Managers and staff limited to chosen stores",
};

/** The plan card's bullets, from its allowances and the features it starts. */
export function planBullets(plan: PricingPlan, catalog: Pick<BillingPlansResponse, "gatePlans" | "features">, currency: BillingCurrency): string[] {
  const n = (v: number) => formatCount(v, currency);
  const fee = (m: Money) => formatPrice(m[currency], currency);
  const each = (included: number, one: string, many: string, extra: Money | null) =>
    `${n(included)} ${included === 1 ? one : many}${extra ? `, then ${fee(extra)} a month each` : ""}`;
  const { members, storeLocations, whatsappNumbers, callingMinutes } = plan;
  if (plan.fairUseChats === null) return ["Chats, users, stores, numbers and calling minutes to fit your brands", ...plan.extras];
  const features = catalog.features[plan.id];
  const starts = (Object.keys(GATE_TEXT) as PlanGate[]).filter((gate) => catalog.gatePlans[gate] === plan.id).map((gate) => GATE_TEXT[gate]);
  return [
    "Unlimited chats, under fair use",
    members.included === null ? "Unlimited users" : each(members.included, "team member", "team members", members.fee),
    ...(plan.opsSeat ? [`Packing and till staff ${fee(plan.opsSeat)} a month each`] : []),
    each(storeLocations.included!, "store with POS", "stores with POS", storeLocations.fee),
    each(whatsappNumbers.included!, "WhatsApp number", "WhatsApp numbers", whatsappNumbers.fee),
    `${n(callingMinutes.included!)} calling minutes, then ${fee(callingMinutes.fee!)} a minute`,
    `${n(features.aiDraftsPerDay)} AI template drafts a day`,
    ...starts,
    ...(features.apiRequestsPerMinute > 600 ? [`${n(features.apiRequestsPerMinute)} API requests a minute`] : []),
    ...plan.extras,
  ];
}

/**
 * Is this gated feature locked for the workspace? Only when the server says
 * so (planFeatures, all open while plans are not enforced); while the
 * workspace is loading nothing is locked: the server refuses anyway.
 */
export function gateLocked(org: Pick<OrgResponse, "planFeatures"> | null | undefined, gate: PlanGate): boolean {
  return org?.planFeatures?.[gate] === false;
}

/** Shown from day 10 of a 14-day trial: five days left, today counted. */
export const TRIAL_BANNER_DAYS = 5;

export interface BillingBanner {
  tone: "info" | "warning" | "danger";
  text: string;
}

/** The app's billing banner: near the trial's end, while payment is needed, and once read-only. */
export function billingBanner(access: BillingAccess | null | undefined): BillingBanner | null {
  if (!access?.enforced) return null;
  if (access.state === "trialing" && access.daysLeft !== null && access.daysLeft <= TRIAL_BANNER_DAYS) {
    return { tone: "info", text: `Your trial ends in ${access.daysLeft} ${access.daysLeft === 1 ? "day" : "days"}. Choose a plan.` };
  }
  if (access.state === "grace") {
    return { tone: "warning", text: `Payment needed. The workspace turns read-only on ${formatDate(access.readOnlyFrom)}.` };
  }
  if (access.state === "expired") return { tone: "danger", text: "Read-only until a plan is active." };
  return null;
}
