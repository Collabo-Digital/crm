import { BillingPlan } from '@prisma/client';

import { NO_USAGE, periodOf, periodRange, planFeatures, PLANS, previousPeriod, pricingPlan, usageCharges, YEARLY_DISCOUNT_PERCENT } from './pricing';

describe('plans', () => {
    it('are Starter, Growth, Pro, Scale and Enterprise, under their stored ids', () => {
        expect(PLANS.map((p) => [p.id, p.name])).toEqual([
            ['BASIC', 'Starter'],
            ['GROWTH', 'Growth'],
            ['PRO', 'Pro'],
            ['SCALE', 'Scale'],
            ['ADVANCE', 'Enterprise'],
        ]);
        expect(PLANS.filter((p) => p.highlighted).map((p) => p.id)).toEqual(['GROWTH']);
    });

    it.each([
        ['BASIC', { INR: 2499, USD: 29 }, { INR: 1999, USD: 23 }],
        ['GROWTH', { INR: 6999, USD: 79 }, { INR: 5599, USD: 63 }],
        ['PRO', { INR: 12499, USD: 149 }, { INR: 9999, USD: 119 }],
        ['SCALE', { INR: 24999, USD: 299 }, { INR: 19999, USD: 239 }],
    ] as const)('price %s a month, and a month when paid yearly, in rupees and dollars', (id, monthly, yearly) => {
        expect(pricingPlan(id).price).toEqual({ MONTHLY: monthly, YEARLY: yearly });
    });

    it('take 20% off for paying a year ahead, rounded down', () => {
        for (const p of PLANS.filter((plan) => plan.price)) {
            for (const currency of ['INR', 'USD'] as const) {
                expect(p.price!.YEARLY[currency]).toBe(Math.floor((p.price!.MONTHLY[currency] * (100 - YEARLY_DISCOUNT_PERCENT)) / 100));
            }
        }
    });

    it('have allowances that grow with the plan', () => {
        const row = (id: BillingPlan) => {
            const p = pricingPlan(id);
            return [p.conversations.included, p.members.included, p.storeLocations.included, p.whatsappNumbers.included, p.callingMinutes.included];
        };
        expect(row(BillingPlan.BASIC)).toEqual([2_000, 3, 1, 1, 500]);
        expect(row(BillingPlan.GROWTH)).toEqual([15_000, 8, 2, 2, 1_500]);
        expect(row(BillingPlan.PRO)).toEqual([100_000, 15, 5, 3, 3_000]);
        expect(row(BillingPlan.SCALE)).toEqual([300_000, 30, 10, 5, 6_000]);
    });

    it('are bought at checkout up to Pro; Scale after a demo and Enterprise on a contract', () => {
        expect(PLANS.map((p) => [p.id, p.selfServe, p.sales])).toEqual([
            ['BASIC', true, 'checkout'],
            ['GROWTH', true, 'checkout'],
            ['PRO', true, 'checkout'],
            ['SCALE', false, 'demo'],
            ['ADVANCE', false, 'contract'],
        ]);
        expect(pricingPlan(BillingPlan.ADVANCE).price).toBeNull();
    });
});

describe('planFeatures', () => {
    it('gives Scale and Enterprise store-limited staff, 2,000 API requests a minute and invoices', () => {
        for (const id of [BillingPlan.SCALE, BillingPlan.ADVANCE]) {
            expect(planFeatures(id)).toEqual({ storeScoping: true, apiRequestsPerMinute: 2_000, invoiceBilling: true });
        }
        for (const id of [BillingPlan.BASIC, BillingPlan.GROWTH, BillingPlan.PRO]) {
            expect(planFeatures(id)).toEqual({ storeScoping: false, apiRequestsPerMinute: 600, invoiceBilling: false });
        }
    });
});

describe('usageCharges', () => {
    const starter = pricingPlan(BillingPlan.BASIC);
    const busy = { conversations: 2_734, callingMinutes: 600, members: 4, opsSeats: 2, storeLocations: 2, whatsappNumbers: 2, instagramAccounts: 1 };

    it('charges what is over each allowance, each add-on, and Instagram, with GST on rupee bills', () => {
        const c = usageCharges(starter, 'INR', busy);
        expect(c.lines).toEqual([
            { key: 'conversations', quantity: 734, unitPrice: 0.25, amount: 18_350 },
            { key: 'callingMinutes', quantity: 100, unitPrice: 0.35, amount: 3_500 },
            { key: 'members', quantity: 1, unitPrice: 699, amount: 69_900 },
            { key: 'opsSeats', quantity: 2, unitPrice: 199, amount: 39_800 },
            { key: 'storeLocations', quantity: 1, unitPrice: 999, amount: 99_900 },
            { key: 'whatsappNumbers', quantity: 1, unitPrice: 999, amount: 99_900 },
            { key: 'instagram', quantity: 1, unitPrice: 799, amount: 79_900 },
        ]);
        expect(c.subtotal).toBe(411_250);
        expect(c.tax).toBe(74_025);
        expect(c.total).toBe(485_275);
    });

    it('prices dollar bills in cents to the nearest cent, without GST', () => {
        const c = usageCharges(starter, 'USD', busy);
        expect(c.lines.map((l) => [l.key, l.amount])).toEqual([
            ['conversations', 220],
            ['callingMinutes', 40],
            ['members', 900],
            ['opsSeats', 600],
            ['storeLocations', 1_200],
            ['whatsappNumbers', 1_200],
            ['instagram', 999],
        ]);
        expect(c.tax).toBe(0);
        expect(c.total).toBe(5_159);
    });

    it('lets ops seats use the seats full members leave free, and charges the rest at the ops price', () => {
        const c = usageCharges(starter, 'INR', { ...NO_USAGE, members: 1, opsSeats: 3 });
        expect(c.lines).toEqual([{ key: 'opsSeats', quantity: 1, unitPrice: 199, amount: 19_900 }]);
        expect(usageCharges(starter, 'INR', { ...NO_USAGE, members: 1, opsSeats: 2 }).total).toBe(0);
    });

    it('charges nothing within the allowances', () => {
        const c = usageCharges(starter, 'INR', { conversations: 2_000, callingMinutes: 500, members: 3, opsSeats: 0, storeLocations: 1, whatsappNumbers: 1, instagramAccounts: 0 });
        expect(c).toEqual({ lines: [], subtotal: 0, tax: 0, total: 0 });
    });

    it.each([
        ['GROWTH', 15_001, 0.15, 15],
        ['PRO', 100_001, 0.1, 10],
        ['SCALE', 300_001, 0.07, 7],
    ] as const)('prices %s chats over its allowance at its own fee', (id, conversations, unitPrice, amount) => {
        const c = usageCharges(pricingPlan(id), 'INR', { ...NO_USAGE, conversations });
        expect(c.lines).toEqual([{ key: 'conversations', quantity: 1, unitPrice, amount }]);
    });

    it('prices Scale minutes and chats in dollars to four decimals', () => {
        const c = usageCharges(pricingPlan(BillingPlan.SCALE), 'USD', { ...NO_USAGE, conversations: 310_000, callingMinutes: 6_500 });
        expect(c.lines).toEqual([
            { key: 'conversations', quantity: 10_000, unitPrice: 0.0008, amount: 800 },
            { key: 'callingMinutes', quantity: 500, unitPrice: 0.0024, amount: 120 },
        ]);
    });

    it('leaves Enterprise to its contract', () => {
        const heavy = { conversations: 1e7, callingMinutes: 1e5, members: 400, opsSeats: 90, storeLocations: 60, whatsappNumbers: 20, instagramAccounts: 3 };
        expect(usageCharges(pricingPlan(BillingPlan.ADVANCE), 'INR', heavy).total).toBe(0);
    });
});

describe('billing periods', () => {
    it('are calendar months in UTC', () => {
        expect(periodOf(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
        expect(previousPeriod(new Date('2027-01-01T00:30:00Z'))).toBe('2026-12');
        expect(periodRange('2026-12')).toEqual({ start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') });
    });
});
