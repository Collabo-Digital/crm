import type { BillingAccess, BillingCurrency, BillingInterval, BillingPlansResponse, Money, PricingPlan } from "~/types/api";
import { formatDate } from "./format-date.ts";
import { formatCurrency } from "./utils.ts";

/**
 * Prices and plan copy for the plan cards, Settings → Billing and the app's
 * billing banner. Plain functions with no React, so `node --test` runs them.
 */

/** Rupees as read in India (₹1,00,000), dollars as in the US ($59, not US$59). */
const LOCALE: Record<BillingCurrency, string> = { INR: "en-IN", USD: "en-US" };

/** Whole amounts without decimals (₹2,499); fees to four places ($0.0035). */
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
  "Every plan has every selling feature. A chat is 24 hours of WhatsApp messages with one customer, starting with the first message either way. Usage over your plan is billed after each month ends. WhatsApp's own message charges are paid to Meta directly, at Meta's price, with no markup.";

/** What the plan costs a month, paid this way; null when priced per contract. */
export function monthlyPrice(plan: PricingPlan, interval: BillingInterval, currency: BillingCurrency): number | null {
  return plan.price ? plan.price[interval][currency] : null;
}

/** The line under the price: how it is billed, and the tax on it. */
export function billingLine(plan: PricingPlan, interval: BillingInterval, currency: BillingCurrency, gstPercent: number): string | null {
  if (!plan.price) return null;
  const tax = currency === "INR" ? ` + ${gstPercent}% GST` : "";
  if (interval === "YEARLY") return `Billed yearly, ${formatPrice(plan.price.YEARLY[currency] * 12, currency)}${tax}`;
  return currency === "INR" ? `Billed monthly${tax}` : "Billed monthly in US dollars";
}

/** Can this plan be bought at checkout, paid this way, in this currency? */
export function buyable(catalog: BillingPlansResponse, plan: PricingPlan, interval: BillingInterval, currency: BillingCurrency): boolean {
  return plan.selfServe && (catalog.checkout[plan.id]?.[interval] ?? []).includes(currency);
}

/** The plan card's bullets, from its allowances. Instagram and Messenger only where offered. */
export function planBullets(
  plan: PricingPlan,
  currency: BillingCurrency,
  offered: { instagram: boolean; messenger: boolean },
): string[] {
  const n = (v: number) => formatCount(v, currency);
  const fee = (m: Money) => formatPrice(m[currency], currency);
  const { conversations, members, storeLocations, whatsappNumbers, callingMinutes } = plan;
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
  const bullets =
    conversations.included === null
      ? ["Chats, seats, store locations, numbers and calling minutes to fit your volume"]
      : [
          `${n(conversations.included)} chats a month, then ${fee(conversations.fee!)} each`,
          `${n(members.included!)} team ${plural(members.included!, "seat", "seats")}, then ${fee(members.fee!)} a month each`,
          ...(plan.opsSeat ? [`Packing and till-only seats ${fee(plan.opsSeat)} a month each`] : []),
          `${n(storeLocations.included!)} store ${plural(storeLocations.included!, "location", "locations")}, then ${fee(storeLocations.fee!)} a month each`,
          `${n(whatsappNumbers.included!)} WhatsApp ${plural(whatsappNumbers.included!, "number", "numbers")}, then ${fee(whatsappNumbers.fee!)} a month each`,
          `${n(callingMinutes.included!)} calling minutes, then ${fee(callingMinutes.fee!)} a minute`,
        ];
  return [
    ...bullets,
    ...(offered.instagram ? [plan.instagram ? `Instagram: ${fee(plan.instagram)} a month per account` : "Instagram included"] : []),
    ...(offered.messenger ? ["Messenger included"] : []),
    ...plan.extras,
  ];
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
