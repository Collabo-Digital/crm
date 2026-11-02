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

/** How a plan is bought: at checkout, after a demo (set up and invoiced by the Collabo team), or on a contract. */
export type PlanSales = 'checkout' | 'demo' | 'contract';

export interface PlanPricing {
    id: BillingPlan;
    name: string;
    tagline: string;
    /**
     * A month, before GST: paid monthly, or the month's price when paid for a
     * year ahead (a yearly bill is twelve of them). Null: priced per contract.
     */
    price: Record<BillingInterval, Money> | null;
    highlighted?: boolean;
    /** Bought at checkout. Scale and Enterprise are set up with the Collabo team. */
    selfServe: boolean;
    sales: PlanSales;
    /** "Chats" to customers: 24 hours of WhatsApp with one person. */
    conversations: Allowance;
    /** Full seats: owners, admins, managers and agents. */
    members: Allowance;
    /** Each packing or till-only seat beyond the seats included. Null: set by contract. */
    opsSeat: Money | null;
    /** Stock locations of the Store kind, where the till sells. */
    storeLocations: Allowance;
    whatsappNumbers: Allowance;
    callingMinutes: Allowance;
    /** Each connected Instagram account, a month. Null: included. */
    instagram: Money | null;
    /** What the plan has beyond its volumes. */
    extras: string[];
}

/** On rupee bills. Dollar bills are for customers outside India and carry none. */
export const GST_PERCENT = 18;

/** Yearly prices are this much below twelve monthly ones (rounded down to the rupee or dollar). */
export const YEARLY_DISCOUNT_PERCENT = 20;

const EXTRA_SEAT: Money = { INR: 699, USD: 9 };
const OPS_SEAT: Money = { INR: 199, USD: 3 };
const EXTRA_LOCATION: Money = { INR: 999, USD: 12 };
const EXTRA_NUMBER: Money = { INR: 999, USD: 12 };
const INSTAGRAM: Money = { INR: 799, USD: 9.99 };
const CONTRACT: Allowance = { included: null, fee: null };

/**
 * Collabo's plans. Every selling feature is in every plan; they differ by
 * volume, and Scale and Enterprise add controls for large teams. Merchants pay
 * Meta's WhatsApp charges to Meta directly: these are Collabo's own fees.
 * The stored ids are older than the names: BASIC is Starter, ADVANCE is Enterprise.
 */
export const PLANS: PlanPricing[] = [
    {
        id: BillingPlan.BASIC,
        name: 'Starter',
        tagline: 'For brands starting to sell and support on WhatsApp.',
        price: { MONTHLY: { INR: 2499, USD: 29 }, YEARLY: { INR: 1999, USD: 23 } },
        selfServe: true,
        sales: 'checkout',
        conversations: { included: 2_000, fee: { INR: 0.25, USD: 0.003 } },
        members: { included: 3, fee: EXTRA_SEAT },
        opsSeat: OPS_SEAT,
        storeLocations: { included: 1, fee: EXTRA_LOCATION },
        whatsappNumbers: { included: 1, fee: EXTRA_NUMBER },
        callingMinutes: { included: 500, fee: { INR: 0.35, USD: 0.004 } },
        instagram: INSTAGRAM,
        extras: [],
    },
    {
        id: BillingPlan.GROWTH,
        name: 'Growth',
        tagline: 'For brands selling every day, online and in store.',
        price: { MONTHLY: { INR: 6999, USD: 79 }, YEARLY: { INR: 5599, USD: 63 } },
        highlighted: true,
        selfServe: true,
        sales: 'checkout',
        conversations: { included: 15_000, fee: { INR: 0.15, USD: 0.0018 } },
        members: { included: 8, fee: EXTRA_SEAT },
        opsSeat: OPS_SEAT,
        storeLocations: { included: 2, fee: EXTRA_LOCATION },
        whatsappNumbers: { included: 2, fee: EXTRA_NUMBER },
        callingMinutes: { included: 1_500, fee: { INR: 0.3, USD: 0.0035 } },
        instagram: INSTAGRAM,
        extras: [],
    },
    {
        id: BillingPlan.PRO,
        name: 'Pro',
        tagline: 'For busy teams with several stores and numbers.',
        price: { MONTHLY: { INR: 12499, USD: 149 }, YEARLY: { INR: 9999, USD: 119 } },
        selfServe: true,
        sales: 'checkout',
        conversations: { included: 100_000, fee: { INR: 0.1, USD: 0.0012 } },
        members: { included: 15, fee: EXTRA_SEAT },
        opsSeat: OPS_SEAT,
        storeLocations: { included: 5, fee: EXTRA_LOCATION },
        whatsappNumbers: { included: 3, fee: EXTRA_NUMBER },
        callingMinutes: { included: 3_000, fee: { INR: 0.25, USD: 0.003 } },
        instagram: INSTAGRAM,
        extras: [],
    },
    {
        id: BillingPlan.SCALE,
        name: 'Scale',
        tagline: 'For major brands with many stores and a large team.',
        price: { MONTHLY: { INR: 24999, USD: 299 }, YEARLY: { INR: 19999, USD: 239 } },
        selfServe: false,
        sales: 'demo',
        conversations: { included: 300_000, fee: { INR: 0.07, USD: 0.0008 } },
        members: { included: 30, fee: EXTRA_SEAT },
        opsSeat: OPS_SEAT,
        storeLocations: { included: 10, fee: EXTRA_LOCATION },
        whatsappNumbers: { included: 5, fee: EXTRA_NUMBER },
        callingMinutes: { included: 6_000, fee: { INR: 0.2, USD: 0.0024 } },
        instagram: INSTAGRAM,
        extras: [
            'Managers and staff limited to chosen stores',
            'Priority support with a named contact',
            '2,000 API requests a minute',
            'Pay yearly by invoice and bank transfer',
        ],
    },
    {
        id: BillingPlan.ADVANCE,
        name: 'Enterprise',
        tagline: 'For groups of brands, on a contract that fits.',
        price: null,
        selfServe: false,
        sales: 'contract',
        conversations: CONTRACT,
        members: CONTRACT,
        opsSeat: null,
        storeLocations: CONTRACT,
        whatsappNumbers: CONTRACT,
        callingMinutes: CONTRACT,
        instagram: null,
        extras: ['Several brands on one contract', 'Everything in Scale'],
    },
];

export function pricingPlan(id: BillingPlan): PlanPricing {
    return PLANS.find((p) => p.id === id)!;
}

export interface PlanFeatures {
    /** Managers and agents can be limited to chosen store locations. */
    storeScoping: boolean;
    /** Public API requests each key may make to each endpoint in a minute. */
    apiRequestsPerMinute: number;
    /** Paid by invoice and bank transfer, set up by the Collabo team. */
    invoiceBilling: boolean;
}

const LARGE_TEAM_PLANS: BillingPlan[] = [BillingPlan.SCALE, BillingPlan.ADVANCE];

/** The controls a plan adds beyond volume: Scale and Enterprise have them. */
export function planFeatures(plan: BillingPlan): PlanFeatures {
    const large = LARGE_TEAM_PLANS.includes(plan);
    return { storeScoping: large, apiRequestsPerMinute: large ? 2_000 : 600, invoiceBilling: large };
}

/**
 * What an organization used in a month. Seats, locations, numbers and
 * Instagram accounts are counted as they are when the bill is made.
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

export type ChargeKey = 'conversations' | 'callingMinutes' | 'members' | 'opsSeats' | 'storeLocations' | 'whatsappNumbers' | 'instagram';

export interface ChargeLine {
    key: ChargeKey;
    /** The units over the allowance, or the Instagram accounts. */
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

/** A month's charges over the plan's allowances, in the smallest unit of the currency. */
export function usageCharges(plan: PlanPricing, currency: BillingCurrency, usage: Usage): Charges {
    const lines: ChargeLine[] = [];
    const over = (key: ChargeKey, used: number, allowance: Allowance) => {
        if (allowance.included === null || !allowance.fee) return;
        const quantity = Math.max(0, used - allowance.included);
        if (quantity > 0) lines.push(line(key, quantity, allowance.fee[currency]));
    };
    over('conversations', usage.conversations, plan.conversations);
    over('callingMinutes', usage.callingMinutes, plan.callingMinutes);
    over('members', usage.members, plan.members);
    // Seats the full members leave free are taken by ops seats first; only the rest are charged, at the ops price.
    if (plan.opsSeat && plan.members.included !== null) {
        const free = Math.max(0, plan.members.included - usage.members);
        over('opsSeats', usage.opsSeats, { included: free, fee: plan.opsSeat });
    }
    over('storeLocations', usage.storeLocations, plan.storeLocations);
    over('whatsappNumbers', usage.whatsappNumbers, plan.whatsappNumbers);
    if (plan.instagram && usage.instagramAccounts > 0) lines.push(line('instagram', usage.instagramAccounts, plan.instagram[currency]));
    const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
    const tax = currency === 'INR' ? Math.round((subtotal * GST_PERCENT) / 100) : 0;
    return { lines, subtotal, tax, total: subtotal + tax };
}

/** Fees go to four decimals ($0.0035), so the product is taken in ten-thousandths. */
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
