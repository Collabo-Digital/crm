import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { BillingPlansResponse, PlanFeatures, PricingPlan } from "../types/api.ts";
import { billingBanner, buyable, demoHref, formatPrice, gateLocked, mandateNote, monthlyLine, planBullets, planChannels, priceFor, yearlyLine } from "./plan-pricing.ts";

// The server's price list (server/src/billing/pricing.ts), as GET /billing/plans sends it.
const place = { INR: 999, USD: 12 };
const starter: PricingPlan = {
  id: "BASIC",
  name: "Starter",
  badge: null,
  bestFor: "brands with up to about 1,000 orders a month",
  price: { MONTHLY: { INR: 8999, USD: 109 }, YEARLY: { INR: 89990, USD: 1090 } },
  selfServe: true,
  sales: "demo",
  fairUseChats: 25_000,
  members: { included: 5, fee: { INR: 999, USD: 12 } },
  opsSeat: { INR: 199, USD: 3 },
  storeLocations: { included: 1, fee: place },
  whatsappNumbers: { included: 1, fee: place },
  callingMinutes: { included: 1_000, fee: { INR: 0.35, USD: 0.004 } },
  extras: [],
};
const growth: PricingPlan = {
  ...starter,
  id: "GROWTH",
  name: "Growth",
  badge: "Recommended",
  highlighted: true,
  bestFor: "brands with 1,000 to 5,000 orders a month",
  price: { MONTHLY: { INR: 12999, USD: 159 }, YEARLY: { INR: 129990, USD: 1590 } },
  fairUseChats: 100_000,
  members: { included: 10, fee: { INR: 799, USD: 10 } },
  storeLocations: { included: 3, fee: place },
  whatsappNumbers: { included: 2, fee: place },
  callingMinutes: { included: 2_000, fee: { INR: 0.25, USD: 0.003 } },
};
const contract = { included: null, fee: null };
const unlimited: PricingPlan = {
  ...starter,
  id: "SCALE",
  name: "Unlimited",
  badge: "For high-volume teams",
  bestFor: "brands with more than 5,000 orders a month",
  price: { MONTHLY: { INR: 19999, USD: 239 }, YEARLY: { INR: 199990, USD: 2390 } },
  fairUseChats: 300_000,
  members: contract,
  opsSeat: null,
  storeLocations: { included: 10, fee: place },
  whatsappNumbers: { included: 5, fee: place },
  callingMinutes: { included: 5_000, fee: { INR: 0.2, USD: 0.0024 } },
  extras: ["Priority support and custom setup"],
};
const enterprise: PricingPlan = {
  id: "ADVANCE",
  name: "Enterprise",
  badge: null,
  bestFor: "groups of brands",
  price: null,
  selfServe: false,
  sales: "contract",
  fairUseChats: null,
  members: contract,
  opsSeat: null,
  storeLocations: contract,
  whatsappNumbers: contract,
  callingMinutes: contract,
  extras: ["Several brands on one contract", "Everything in Unlimited"],
};
const features = (gates: [boolean, boolean, boolean, boolean], api: number, drafts: number): PlanFeatures => ({
  packing: gates[0], messagingAnalytics: gates[1], publicApi: gates[2], storeScoping: gates[3], apiRequestsPerMinute: api, aiDraftsPerDay: drafts, invoiceBilling: false,
});
const catalog: BillingPlansResponse = {
  plans: [starter, growth, unlimited, enterprise],
  gstPercent: 18,
  yearlyMonthsFree: 2,
  features: {
    BASIC: features([false, false, false, false], 600, 20),
    GROWTH: features([true, true, true, false], 600, 50),
    SCALE: features([true, true, true, true], 2_000, 100),
    ADVANCE: features([true, true, true, true], 2_000, 100),
  },
  gatePlans: { packing: "GROWTH", messagingAnalytics: "GROWTH", publicApi: "GROWTH", storeScoping: "SCALE" },
  checkout: { BASIC: { MONTHLY: ["INR", "USD"], YEARLY: ["INR"] }, GROWTH: { MONTHLY: ["INR"], YEARLY: ["INR"] }, SCALE: { MONTHLY: [], YEARLY: ["INR"] } },
  salesEmail: "sales@collabo.test",
  demoUrl: null,
  enforcement: true,
  trialDays: 14,
};

describe("plan card prices", () => {
  it("show each plan's month with GST on top, and its year under it, in rupees and dollars", () => {
    assert.deepEqual(
      catalog.plans.map((p) => [p.name, monthlyLine(p, "INR"), yearlyLine(p, "INR", 2), monthlyLine(p, "USD"), yearlyLine(p, "USD", 2)]),
      [
        ["Starter", "₹8,999 + GST / month", "or ₹89,990 a year, two months free", "$109 / month", "or $1,090 a year, two months free"],
        ["Growth", "₹12,999 + GST / month", "or ₹1,29,990 a year, two months free", "$159 / month", "or $1,590 a year, two months free"],
        ["Unlimited", "₹19,999 + GST / month", "or ₹1,99,990 a year, two months free", "$239 / month", "or $2,390 a year, two months free"],
        ["Enterprise", null, null, null, null],
      ],
    );
  });

  it("price what a subscription is billed, with the GST", () => {
    assert.equal(priceFor(growth, "YEARLY", "INR", 18), "₹1,29,990 a year + 18% GST");
    assert.equal(priceFor(starter, "MONTHLY", "INR", 18), "₹8,999 a month + 18% GST");
    assert.equal(priceFor(unlimited, "MONTHLY", "USD", 18), "$239 a month");
    assert.equal(formatPrice(0.0024, "USD"), "$0.0024");
  });

  it("list the allowances and the features each plan adds, in plain words", () => {
    assert.deepEqual(planBullets(starter, catalog, "INR"), [
      "Unlimited chats, under fair use",
      "5 team members, then ₹999 a month each",
      "Packing and till staff ₹199 a month each",
      "1 store with POS, then ₹999 a month each",
      "1 WhatsApp number, then ₹999 a month each",
      "1,000 calling minutes, then ₹0.35 a minute",
      "20 AI template drafts a day",
    ]);
    assert.deepEqual(planBullets(growth, catalog, "USD"), [
      "Unlimited chats, under fair use",
      "10 team members, then $10 a month each",
      "Packing and till staff $3 a month each",
      "3 stores with POS, then $12 a month each",
      "2 WhatsApp numbers, then $12 a month each",
      "2,000 calling minutes, then $0.003 a minute",
      "50 AI template drafts a day",
      "Packing assistant",
      "Team performance and messaging analytics",
      "Public API and webhooks",
    ]);
    assert.deepEqual(planBullets(unlimited, catalog, "INR"), [
      "Unlimited chats, under fair use",
      "Unlimited users",
      "10 stores with POS, then ₹999 a month each",
      "5 WhatsApp numbers, then ₹999 a month each",
      "5,000 calling minutes, then ₹0.20 a minute",
      "100 AI template drafts a day",
      "Managers and staff limited to chosen stores",
      "2,000 API requests a minute",
      "Priority support and custom setup",
    ]);
    assert.deepEqual(planBullets(enterprise, catalog, "INR"), [
      "Chats, users, stores, numbers and calling minutes to fit your brands",
      "Several brands on one contract",
      "Everything in Unlimited",
    ]);
  });

  it("show Instagram DM among the channels only where the app offers Instagram", () => {
    assert.deepEqual(planChannels({ instagram: false }), ["WhatsApp", "Website chat buttons"]);
    assert.deepEqual(planChannels({ instagram: true }), ["WhatsApp", "Instagram DM", "Website chat buttons"]);
  });

  it("book a demo at the demo link when there is one, otherwise by email to sales", () => {
    assert.equal(demoHref(catalog, "Collabo Growth demo"), "mailto:sales@collabo.test?subject=Collabo%20Growth%20demo");
    assert.equal(demoHref({ ...catalog, demoUrl: "https://cal.example.com/collabo" }, "x"), "https://cal.example.com/collabo");
    assert.equal(demoHref({ demoUrl: null, salesEmail: null }, "x"), null);
  });
});

describe("subscribing", () => {
  it("warns that a monthly charge above ₹15,000 with GST needs the customer's approval each month", () => {
    assert.match(mandateNote(growth, "MONTHLY", "INR", 18) ?? "", /approve each monthly charge/);
    assert.match(mandateNote(unlimited, "MONTHLY", "INR", 18) ?? "", /Pay yearly/);
    assert.equal(mandateNote(starter, "MONTHLY", "INR", 18), null);
    assert.equal(mandateNote(growth, "YEARLY", "INR", 18), null);
    assert.equal(mandateNote(growth, "MONTHLY", "USD", 18), null);
  });

  it("is possible only where a Razorpay plan exists for that interval and currency", () => {
    assert.equal(buyable(catalog, starter, "YEARLY", "INR"), true);
    assert.equal(buyable(catalog, starter, "YEARLY", "USD"), false);
    assert.equal(buyable(catalog, unlimited, "MONTHLY", "INR"), false);
    assert.equal(buyable(catalog, enterprise, "YEARLY", "INR"), false);
  });
});

describe("plan gates", () => {
  it("lock a feature only when the server says the plan lacks it", () => {
    const org = { planFeatures: { packing: false, messagingAnalytics: false, publicApi: false, storeScoping: false } };
    assert.equal(gateLocked(org, "packing"), true);
    assert.equal(gateLocked({ planFeatures: { ...org.planFeatures, packing: true } }, "packing"), false);
    // Still loading, or a server from before plan gates: nothing locked.
    assert.equal(gateLocked(undefined, "packing"), false);
    assert.equal(gateLocked({}, "publicApi"), false);
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
