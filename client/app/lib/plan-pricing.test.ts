import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { BillingPlansResponse, PricingPlan } from "../types/api.ts";
import { billingBanner, billingLine, buyable, formatPrice, monthlyPrice, planBullets } from "./plan-pricing.ts";

const addOns = {
  opsSeat: { INR: 199, USD: 3 },
  instagram: { INR: 799, USD: 9.99 },
  extras: [],
  selfServe: true,
  sales: "checkout" as const,
};
const seat = { INR: 699, USD: 9 };
const place = { INR: 999, USD: 12 };

// The server's price list (server/src/billing/pricing.ts), as GET /billing/plans sends it.
const starter: PricingPlan = {
  id: "BASIC",
  name: "Starter",
  tagline: "",
  price: { MONTHLY: { INR: 2499, USD: 29 }, YEARLY: { INR: 1999, USD: 23 } },
  conversations: { included: 2_000, fee: { INR: 0.25, USD: 0.003 } },
  members: { included: 3, fee: seat },
  storeLocations: { included: 1, fee: place },
  whatsappNumbers: { included: 1, fee: place },
  callingMinutes: { included: 500, fee: { INR: 0.35, USD: 0.004 } },
  ...addOns,
};
const growth: PricingPlan = {
  ...starter,
  id: "GROWTH",
  name: "Growth",
  price: { MONTHLY: { INR: 6999, USD: 79 }, YEARLY: { INR: 5599, USD: 63 } },
  conversations: { included: 15_000, fee: { INR: 0.15, USD: 0.0018 } },
  members: { included: 8, fee: seat },
  storeLocations: { included: 2, fee: place },
  whatsappNumbers: { included: 2, fee: place },
  callingMinutes: { included: 1_500, fee: { INR: 0.3, USD: 0.0035 } },
};
const pro: PricingPlan = { ...starter, id: "PRO", name: "Pro", price: { MONTHLY: { INR: 12499, USD: 149 }, YEARLY: { INR: 9999, USD: 119 } }, conversations: { included: 100_000, fee: { INR: 0.1, USD: 0.0012 } } };
const scale: PricingPlan = {
  ...starter,
  id: "SCALE",
  name: "Scale",
  price: { MONTHLY: { INR: 24999, USD: 299 }, YEARLY: { INR: 19999, USD: 239 } },
  selfServe: false,
  sales: "demo",
  conversations: { included: 300_000, fee: { INR: 0.07, USD: 0.0008 } },
  extras: ["Pay yearly by invoice and bank transfer"],
};
const contract = { included: null, fee: null };
const enterprise: PricingPlan = {
  id: "ADVANCE",
  name: "Enterprise",
  tagline: "",
  price: null,
  selfServe: false,
  sales: "contract",
  conversations: contract,
  members: contract,
  opsSeat: null,
  storeLocations: contract,
  whatsappNumbers: contract,
  callingMinutes: contract,
  instagram: null,
  extras: ["Several brands on one contract"],
};
const catalog: BillingPlansResponse = {
  plans: [starter, growth, pro, scale, enterprise],
  gstPercent: 18,
  yearlyDiscountPercent: 20,
  checkout: { BASIC: { MONTHLY: ["INR", "USD"], YEARLY: ["INR"] }, GROWTH: { MONTHLY: ["INR"], YEARLY: [] }, PRO: { MONTHLY: [], YEARLY: [] } },
  salesEmail: "sales@collabo.test",
  enforcement: true,
  trialDays: 14,
};
const card = (plan: PricingPlan, interval: "MONTHLY" | "YEARLY", currency: "INR" | "USD") => {
  const price = monthlyPrice(plan, interval, currency);
  return price === null ? null : formatPrice(price, currency);
};

describe("plan card prices", () => {
  it("show each plan's month, paid monthly or yearly, in rupees and dollars", () => {
    assert.deepEqual(
      catalog.plans.map((p) => [p.name, card(p, "YEARLY", "INR"), card(p, "MONTHLY", "INR"), card(p, "YEARLY", "USD"), card(p, "MONTHLY", "USD")]),
      [
        ["Starter", "₹1,999", "₹2,499", "$23", "$29"],
        ["Growth", "₹5,599", "₹6,999", "$63", "$79"],
        ["Pro", "₹9,999", "₹12,499", "$119", "$149"],
        ["Scale", "₹19,999", "₹24,999", "$239", "$299"],
        ["Enterprise", null, null, null, null],
      ],
    );
  });

  it("say how the price is billed, with GST on rupees", () => {
    assert.equal(billingLine(starter, "YEARLY", "INR", 18), "Billed yearly, ₹23,988 + 18% GST");
    assert.equal(billingLine(scale, "YEARLY", "INR", 18), "Billed yearly, ₹2,39,988 + 18% GST");
    assert.equal(billingLine(starter, "MONTHLY", "INR", 18), "Billed monthly + 18% GST");
    assert.equal(billingLine(growth, "YEARLY", "USD", 18), "Billed yearly, $756");
    assert.equal(billingLine(growth, "MONTHLY", "USD", 18), "Billed monthly in US dollars");
    assert.equal(billingLine(enterprise, "MONTHLY", "INR", 18), null);
  });

  it("list the allowances and add-ons, with fees to four places in dollars", () => {
    assert.deepEqual(planBullets(starter, "INR", { instagram: false, messenger: false }), [
      "2,000 chats a month, then ₹0.25 each",
      "3 team seats, then ₹699 a month each",
      "Packing and till-only seats ₹199 a month each",
      "1 store location, then ₹999 a month each",
      "1 WhatsApp number, then ₹999 a month each",
      "500 calling minutes, then ₹0.35 a minute",
    ]);
    assert.deepEqual(planBullets(growth, "USD", { instagram: true, messenger: false }).filter((b) => /chats|calling|Instagram/.test(b)), [
      "15,000 chats a month, then $0.0018 each",
      "1,500 calling minutes, then $0.0035 a minute",
      "Instagram: $9.99 a month per account",
    ]);
    assert.equal(planBullets(scale, "INR", { instagram: false, messenger: false })[0], "3,00,000 chats a month, then ₹0.07 each");
    assert.equal(planBullets(scale, "INR", { instagram: false, messenger: false }).at(-1), "Pay yearly by invoice and bank transfer");
    assert.deepEqual(planBullets(enterprise, "INR", { instagram: true, messenger: true }), [
      "Chats, seats, store locations, numbers and calling minutes to fit your volume",
      "Instagram included",
      "Messenger included",
      "Several brands on one contract",
    ]);
  });

  it("can be bought only where a Razorpay plan exists for that interval and currency", () => {
    assert.equal(buyable(catalog, starter, "YEARLY", "INR"), true);
    assert.equal(buyable(catalog, starter, "YEARLY", "USD"), false);
    assert.equal(buyable(catalog, growth, "MONTHLY", "INR"), true);
    assert.equal(buyable(catalog, growth, "YEARLY", "INR"), false);
    assert.equal(buyable(catalog, scale, "YEARLY", "INR"), false);
  });
});

describe("billing banner", () => {
  const access = (over: Partial<NonNullable<Parameters<typeof billingBanner>[0]>>) => ({
    state: "trialing" as const,
    enforced: true,
    trialEndsAt: "2026-12-15T00:00:00.000Z",
    readOnlyFrom: null,
    daysLeft: 9,
    ...over,
  });

  it("shows from day 10 of the trial", () => {
    assert.equal(billingBanner(access({ daysLeft: 6 })), null);
    assert.deepEqual(billingBanner(access({ daysLeft: 5 })), { tone: "info", text: "Your trial ends in 5 days. Choose a plan." });
    assert.deepEqual(billingBanner(access({ daysLeft: 1 })), { tone: "info", text: "Your trial ends in 1 day. Choose a plan." });
  });

  it("asks for payment in the grace period, then says the workspace is read-only", () => {
    assert.deepEqual(billingBanner(access({ state: "grace", daysLeft: 3, readOnlyFrom: "2026-12-22T00:00:00.000Z" })), {
      tone: "warning",
      text: "Payment needed. The workspace turns read-only on 22 Dec 2026.",
    });
    assert.deepEqual(billingBanner(access({ state: "expired", daysLeft: null })), { tone: "danger", text: "Read-only until a plan is active." });
  });

  it("stays away on a paid plan and while enforcement is off", () => {
    assert.equal(billingBanner(access({ state: "active", daysLeft: null })), null);
    assert.equal(billingBanner(access({ enforced: false, state: "expired" })), null);
    assert.equal(billingBanner(undefined), null);
  });
});
