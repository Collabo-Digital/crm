import { BillingInterval, BillingPlan } from '@prisma/client';

export type BillingCurrency = 'INR' | 'USD';
export const BILLING_CURRENCIES: BillingCurrency[] = ['INR', 'USD'];
export const BILLING_INTERVALS: BillingInterval[] = [BillingInterval.MONTHLY, BillingInterval.YEARLY];

/** A price in each currency's main unit (rupees, dollars). */
export type Money = Record<BillingCurrency, number>;

/** So many a month without charge, then a fee for each one over. A null `included` means unlimited, or set by contract. */
export interface Allowance {
    included: number | null;
    fee: Money | null;
}

/** How a plan is sold: after a demo (and then subscribed to), or on a contract. */
export type PlanSales = 'demo' | 'contract';

export interface PlanPricing {
    id: BillingPlan;
    name: string;
    /** "Recommended", "For high-volume teams". */
    badge: string | null;
    /** Who the plan suits, after "Best for". */
    bestFor: string;
    /**
     * Before GST: a month when paid monthly, a year when paid yearly (ten
     * months' price, so two months free). Null: priced per contract.
     */
    price: Record<BillingInterval, Money> | null;
    highlighted?: boolean;
    /** Can be subscribed to through Razorpay (after the demo). Enterprise is set up with the Collabo team. */
    selfServe: boolean;
    sales: PlanSales;
    /**
     * Chats (24 hours of WhatsApp with one person) are unlimited under fair
     * use: never charged. Above this many in a month the Collabo team talks
     * to the brand. Null: by contract.
     */
    fairUseChats: number | null;
    /** Full seats: owners, admins, managers and agents. Included null and no fee: unlimited users. */
    members: Allowance;
    /** Each packing or till-only seat beyond the seats included. Null: no seat charges. */
    opsSeat: Money | null;
    /** Stock locations of the Store kind, where the till sells. */
    storeLocations: Allowance;
    whatsappNumbers: Allowance;
    callingMinutes: Allowance;
    /** What the plan has beyond its volumes and plan features, in the card's words. */
    extras: string[];
}

/** On rupee bills. Dollar bills are for customers outside India and carry none. */
export const GST_PERCENT = 18;

/** A year costs ten months. */
export const YEARLY_MONTHS_FREE = 2;

const OPS_SEAT: Money = { INR: 199, USD: 3 };
const EXTRA_PLACE: Money = { INR: 999, USD: 12 };
const CONTRACT: Allowance = { included: null, fee: null };

/**
 * Collabo's plans, sold after a demo. Every plan has GST invoices, the till at
 * its store locations, the inbox, broadcasts, automations, Shopify and orders;
 * higher plans add the features in planFeatures(). Merchants pay Meta's
 * WhatsApp charges to Meta directly: these are Collabo's own fees. The stored
 * ids are older than the names: BASIC is Starter, SCALE is Unlimited and
 * ADVANCE is Enterprise.
 */
export const PLANS: PlanPricing[] = [
    {
        id: BillingPlan.BASIC,
        name: 'Starter',
        badge: null,
        bestFor: 'brands with up to about 1,000 orders a month',
        price: { MONTHLY: { INR: 8999, USD: 109 }, YEARLY: { INR: 89990, USD: 1090 } },
        selfServe: true,
        sales: 'demo',
        fairUseChats: 25_000,
        members: { included: 5, fee: { INR: 999, USD: 12 } },
        opsSeat: OPS_SEAT,
        storeLocations: { included: 1, fee: EXTRA_PLACE },
        whatsappNumbers: { included: 1, fee: EXTRA_PLACE },
        callingMinutes: { included: 1_000, fee: { INR: 0.35, USD: 0.004 } },
        extras: [],
    },
    {
        id: BillingPlan.GROWTH,
        name: 'Growth',
        badge: 'Recommended',
        bestFor: 'brands with 1,000 to 5,000 orders a month',
        price: { MONTHLY: { INR: 12999, USD: 159 }, YEARLY: { INR: 129990, USD: 1590 } },
        highlighted: true,
        selfServe: true,
        sales: 'demo',
        fairUseChats: 100_000,
        members: { included: 10, fee: { INR: 799, USD: 10 } },
        opsSeat: OPS_SEAT,
        storeLocations: { included: 3, fee: EXTRA_PLACE },
        whatsappNumbers: { included: 2, fee: EXTRA_PLACE },
        callingMinutes: { included: 2_000, fee: { INR: 0.25, USD: 0.003 } },
        extras: [],
    },
    {
        id: BillingPlan.SCALE,
        name: 'Unlimited',
        badge: 'For high-volume teams',
        bestFor: 'brands with more than 5,000 orders a month',
        price: { MONTHLY: { INR: 19999, USD: 239 }, YEARLY: { INR: 199990, USD: 2390 } },
        selfServe: true,
        sales: 'demo',
        fairUseChats: 300_000,
        members: CONTRACT,
        opsSeat: null,
        storeLocations: { included: 10, fee: EXTRA_PLACE },
        whatsappNumbers: { included: 5, fee: EXTRA_PLACE },
        callingMinutes: { included: 5_000, fee: { INR: 0.2, USD: 0.0024 } },
        extras: ['Priority support and custom setup'],
    },
    {
        id: BillingPlan.ADVANCE,
        name: 'Enterprise',
        badge: null,
        bestFor: 'groups of brands',
        price: null,
        selfServe: false,
        sales: 'contract',
        fairUseChats: null,
        members: CONTRACT,
        opsSeat: null,
        storeLocations: CONTRACT,
        whatsappNumbers: CONTRACT,
        callingMinutes: CONTRACT,
        extras: ['Several brands on one contract', 'Everything in Unlimited'],
    },
];

export function pricingPlan(id: BillingPlan): PlanPricing {
    return PLANS.find((p) => p.id === id)!;
}

/** Features a plan may lack. Each is refused (@RequirePlanFeature) only while BILLING_ENFORCEMENT is on. */
export type PlanGate = 'packing' | 'messagingAnalytics' | 'publicApi' | 'storeScoping';
export const PLAN_GATES: PlanGate[] = ['packing', 'messagingAnalytics', 'publicApi', 'storeScoping'];

export interface PlanFeatures extends Record<PlanGate, boolean> {
    /** Public API requests each key may make to each endpoint in a minute. */
    apiRequestsPerMinute: number;
    /** AI template drafts the team may ask for in a day. */
    aiDraftsPerDay: number;
    /** Paid by invoice and bank transfer, set up by the Collabo team. */
    invoiceBilling: boolean;
}

const FEATURES: Record<BillingPlan, PlanFeatures> = {
    BASIC: { packing: false, messagingAnalytics: false, publicApi: false, storeScoping: false, apiRequestsPerMinute: 600, aiDraftsPerDay: 20, invoiceBilling: false },
    GROWTH: { packing: true, messagingAnalytics: true, publicApi: true, storeScoping: false, apiRequestsPerMinute: 600, aiDraftsPerDay: 50, invoiceBilling: false },
    SCALE: { packing: true, messagingAnalytics: true, publicApi: true, storeScoping: true, apiRequestsPerMinute: 2_000, aiDraftsPerDay: 100, invoiceBilling: false },
    ADVANCE: { packing: true, messagingAnalytics: true, publicApi: true, storeScoping: true, apiRequestsPerMinute: 2_000, aiDraftsPerDay: 100, invoiceBilling: true },
};

/** What a plan has beyond its volumes. */
export function planFeatures(plan: BillingPlan): PlanFeatures {
    return FEATURES[plan];
}

/** The plan each feature starts on, for "Available on Growth". */
export const GATE_PLAN: Record<PlanGate, BillingPlan> = {
    packing: BillingPlan.GROWTH,
    messagingAnalytics: BillingPlan.GROWTH,
    publicApi: BillingPlan.GROWTH,
    storeScoping: BillingPlan.SCALE,
};

/**
 * What an organization used in a month. Chats are counted for fair use,
 * never charged. Seats, locations, numbers and Instagram accounts are
 * counted as they are when the bill is made.
 */
export interface Usage {
    conversations: number;
    callingMinutes: number;
    /** Full seats. */
    members: number;
    /** Agents who only pack, pick, receive, dispatch or use the till. */
    opsSeats: number;
    storeLocations: number;
    whatsappNumbers: number;
    instagramAccounts: number;
}

export const NO_USAGE: Usage = { conversations: 0, callingMinutes: 0, members: 0, opsSeats: 0, storeLocations: 0, whatsappNumbers: 0, instagramAccounts: 0 };

export type ChargeKey = 'callingMinutes' | 'members' | 'opsSeats' | 'storeLocations' | 'whatsappNumbers';

export interface ChargeLine {
    key: ChargeKey;
    /** The units over the allowance. */
    quantity: number;
    /** In the main unit (rupees, dollars). */
    unitPrice: number;
    /** In the smallest unit (paise, cents). */
    amount: number;
}

export interface Charges {
    lines: ChargeLine[];
    subtotal: number;
    tax: number;
    total: number;
}

/**
 * A month's charges over the plan's allowances, in the smallest unit of the
 * currency: calling minutes, extra seats, packing and till seats, store
 * locations and WhatsApp numbers. Chats and Instagram are never charged.
 */
export function usageCharges(plan: PlanPricing, currency: BillingCurrency, usage: Usage): Charges {
    const lines: ChargeLine[] = [];
    const over = (key: ChargeKey, used: number, allowance: Allowance) => {
        if (allowance.included === null || !allowance.fee) return;
        const quantity = Math.max(0, used - allowance.included);
        if (quantity > 0) lines.push(line(key, quantity, allowance.fee[currency]));
    };
    over('callingMinutes', usage.callingMinutes, plan.callingMinutes);
    over('members', usage.members, plan.members);
    // Seats the full members leave free are taken by ops seats first; only the rest are charged, at the ops price.
    if (plan.opsSeat && plan.members.included !== null) {
        const free = Math.max(0, plan.members.included - usage.members);
        over('opsSeats', usage.opsSeats, { included: free, fee: plan.opsSeat });
    }
    over('storeLocations', usage.storeLocations, plan.storeLocations);
    over('whatsappNumbers', usage.whatsappNumbers, plan.whatsappNumbers);
    const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
    const tax = currency === 'INR' ? Math.round((subtotal * GST_PERCENT) / 100) : 0;
    return { lines, subtotal, tax, total: subtotal + tax };
}

/** Fees go to four decimals ($0.0024), so the product is taken in ten-thousandths. */
function line(key: ChargeKey, quantity: number, unitPrice: number): ChargeLine {
    return { key, quantity, unitPrice, amount: Math.round((quantity * Math.round(unitPrice * 10_000)) / 100) };
}

/** A calendar month in UTC: "2026-10". */
export function periodOf(at: Date): string {
    return at.toISOString().slice(0, 7);
}

export function periodRange(period: string): { start: Date; end: Date } {
    const [year, month] = period.split('-').map(Number);
    return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

export function previousPeriod(at: Date): string {
    return periodOf(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)));
}
