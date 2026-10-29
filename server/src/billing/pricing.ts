import { BillingPlan } from '@prisma/client';

export type BillingCurrency = 'INR' | 'USD';
export const BILLING_CURRENCIES: BillingCurrency[] = ['INR', 'USD'];

/** A price in each currency's main unit (rupees, dollars). */
export type Money = Record<BillingCurrency, number>;

/** So many a month without charge, then a fee for each one over. A null `included` means unlimited. */
export interface Allowance {
    included: number | null;
    fee: Money | null;
}

export interface PlanPricing {
    id: BillingPlan;
    name: string;
    tagline: string;
    /** A month, before GST. Null: priced per contract. */
    price: Money | null;
    highlighted?: boolean;
    /** Checkout is self-serve; Enterprise is set up with the Collabo team. */
    selfServe: boolean;
    conversations: Allowance;
    members: Allowance;
    callingMinutes: Allowance;
    /** Each connected Instagram account, a month. Null: included. */
    instagram: Money | null;
}

/** On rupee bills. Dollar bills are for customers outside India and carry none. */
export const GST_PERCENT = 18;

/**
 * Collabo's plans. Every feature is in every plan; they differ by volume.
 * Merchants pay Meta's WhatsApp charges to Meta directly: these are Collabo's
 * own fees. ADVANCE is the stored id of Enterprise.
 */
export const PLANS: PlanPricing[] = [
    {
        id: BillingPlan.BASIC,
        name: 'Basic',
        tagline: 'For brands starting to sell and support on WhatsApp.',
        price: { INR: 5000, USD: 59 },
        selfServe: true,
        conversations: { included: 5_000, fee: { INR: 0.2, USD: 0.0024 } },
        members: { included: 5, fee: { INR: 1000, USD: 12 } },
        callingMinutes: { included: 1_000, fee: { INR: 0.35, USD: 0.004 } },
        instagram: { INR: 799, USD: 9.99 },
    },
    {
        id: BillingPlan.GROWTH,
        name: 'Growth',
        tagline: 'For brands talking to customers every day, at volume.',
        price: { INR: 15000, USD: 179 },
        highlighted: true,
        selfServe: true,
        conversations: { included: 100_000, fee: { INR: 0.1, USD: 0.0012 } },
        members: { included: 10, fee: { INR: 800, USD: 10 } },
        callingMinutes: { included: 2_000, fee: { INR: 0.25, USD: 0.003 } },
        instagram: { INR: 799, USD: 9.99 },
    },
    {
        id: BillingPlan.ADVANCE,
        name: 'Enterprise',
        tagline: 'For high volumes and custom needs, on a contract that fits.',
        price: null,
        selfServe: false,
        conversations: { included: null, fee: null },
        members: { included: null, fee: null },
        callingMinutes: { included: 4_000, fee: null },
        instagram: null,
    },
];

export function pricingPlan(id: BillingPlan): PlanPricing {
    return PLANS.find((p) => p.id === id)!;
}

/** What an organization used in a month. Members and Instagram accounts are counted as they are. */
export interface Usage {
    conversations: number;
    callingMinutes: number;
    members: number;
    instagramAccounts: number;
}

export type ChargeKey = 'conversations' | 'callingMinutes' | 'members' | 'instagram';

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
    if (plan.instagram && usage.instagramAccounts > 0) lines.push(line('instagram', usage.instagramAccounts, plan.instagram[currency]));
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
