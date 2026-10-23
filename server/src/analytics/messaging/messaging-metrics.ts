import { rateFor } from '../../campaigns/broadcasts/broadcast-audience';

/**
 * The arithmetic behind the messaging dashboard. Pure, so every figure can be
 * checked against a direct count.
 */

/** Nearest-rank percentile (p in 0..100); null for no values. */
export function percentile(values: number[], p: number): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[Math.min(rank, sorted.length) - 1];
}

export interface Touch {
    customerId: string;
    at: Date;
    source: 'broadcast' | 'automation';
    /** The broadcast or automation it came from. */
    refId: string | null;
}

export interface AttributableOrder {
    id: string;
    customerId: string;
    at: Date;
    revenue: number;
}

/**
 * Last touch: an order counts for the most recent broadcast or automation
 * message the customer got in the window before it. Orders with no such
 * message are not attributed.
 */
export function attributeOrders(orders: AttributableOrder[], touches: Touch[], windowMs: number) {
    const byCustomer = new Map<string, Touch[]>();
    for (const t of touches) {
        const list = byCustomer.get(t.customerId) ?? [];
        list.push(t);
        byCustomer.set(t.customerId, list);
    }
    const attributed: Array<{ order: AttributableOrder; touch: Touch }> = [];
    for (const order of orders) {
        const candidates = (byCustomer.get(order.customerId) ?? []).filter(
            (t) => t.at.getTime() <= order.at.getTime() && order.at.getTime() - t.at.getTime() <= windowMs,
        );
        if (!candidates.length) continue;
        const touch = candidates.reduce((latest, t) => (t.at > latest.at ? t : latest));
        attributed.push({ order, touch });
    }
    return attributed;
}

export interface PricedRow {
    category: string | null;
    billable: boolean | null;
    /** Digits of the recipient's number; null when only a username id is known. */
    toDigits: string | null;
    count: number;
}

export interface RateRowNumbers {
    countryPrefix: string;
    currency: string;
    marketing: number | null;
    utility: number | null;
    authentication: number | null;
}

const PRICED = new Set(['marketing', 'utility', 'authentication']);

/**
 * Estimated Meta charges: billable messages by Meta's pricing category,
 * priced from the business's own rate table by the recipient's country code.
 * Categories or countries without a rate are counted, not priced.
 */
export function estimateCost(rows: PricedRow[], rates: RateRowNumbers[]) {
    const byCategory = new Map<string, { category: string; billable: number; free: number; amounts: Map<string, number>; unpriced: number }>();
    for (const r of rows) {
        const category = (r.category ?? 'unknown').toLowerCase();
        const entry = byCategory.get(category) ?? { category, billable: 0, free: 0, amounts: new Map(), unpriced: 0 };
        if (r.billable === false) {
            entry.free += r.count;
        } else {
            entry.billable += r.count;
            const rate = PRICED.has(category) ? rateFor(r.toDigits, rates) : null;
            const price = rate ? (rate[category as 'marketing' | 'utility' | 'authentication'] ?? null) : null;
            if (rate && price !== null) entry.amounts.set(rate.currency, (entry.amounts.get(rate.currency) ?? 0) + price * r.count);
            else entry.unpriced += r.count;
        }
        byCategory.set(category, entry);
    }
    const totals = new Map<string, number>();
    const categories = [...byCategory.values()].map((e) => {
        for (const [cur, amt] of e.amounts) totals.set(cur, (totals.get(cur) ?? 0) + amt);
        return { category: e.category, billable: e.billable, free: e.free, unpriced: e.unpriced, amounts: [...e.amounts].map(([currency, amount]) => ({ currency, amount: round(amount) })) };
    });
    return {
        categories: categories.sort((a, b) => b.billable - a.billable),
        totals: [...totals].map(([currency, amount]) => ({ currency, amount: round(amount) })),
        billable: categories.reduce((n, c) => n + c.billable, 0),
        free: categories.reduce((n, c) => n + c.free, 0),
        unpriced: categories.reduce((n, c) => n + c.unpriced, 0),
    };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** One CSV line, quoting what needs it. */
export function csvLine(values: Array<string | number | null | undefined>): string {
    return values
        .map((v) => {
            const s = v === null || v === undefined ? '' : String(v);
            // A leading = + - @ (or a tab or CR before one) would run as a formula in a spreadsheet.
            const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
            // A bare CR is a line break to some spreadsheets, so it is quoted like a newline.
            return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        })
        .join(',');
}
