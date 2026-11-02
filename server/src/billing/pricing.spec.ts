import { BillingPlan } from '@prisma/client';

import { GATE_PLAN, NO_USAGE, periodOf, periodRange, planFeatures, PLANS, previousPeriod, pricingPlan, usageCharges, YEARLY_MONTHS_FREE } from './pricing';

describe('plans', () => {
    it('are Starter, Growth (recommended), Unlimited and Enterprise, under their stored ids', () => {
        expect(PLANS.map((p) => [p.id, p.name, p.badge])).toEqual([
            ['BASIC', 'Starter', null],
            ['GROWTH', 'Growth', 'Recommended'],
            ['SCALE', 'Unlimited', 'For high-volume teams'],
            ['ADVANCE', 'Enterprise', null],
        ]);
        expect(PLANS.filter((p) => p.highlighted).map((p) => p.id)).toEqual(['GROWTH']);
        expect(pricingPlan(BillingPlan.BASIC).bestFor).toBe('brands with up to about 1,000 orders a month');
        expect(pricingPlan(BillingPlan.GROWTH).bestFor).toBe('brands with 1,000 to 5,000 orders a month');
    });

    it.each([
        ['BASIC', { INR: 8999, USD: 109 }, { INR: 89990, USD: 1090 }],
        ['GROWTH', { INR: 12999, USD: 159 }, { INR: 129990, USD: 1590 }],
        ['SCALE', { INR: 19999, USD: 239 }, { INR: 199990, USD: 2390 }],
    ] as const)('price %s a month, or a year, in rupees and dollars', (id, monthly, yearly) => {
        expect(pricingPlan(id).price).toEqual({ MONTHLY: monthly, YEARLY: yearly });
    });

    it('charge ten months for a year: two months free', () => {
        for (const p of PLANS.filter((plan) => plan.price)) {
            for (const currency of ['INR', 'USD'] as const) {
                expect(p.price!.YEARLY[currency]).toBe(p.price!.MONTHLY[currency] * (12 - YEARLY_MONTHS_FREE));
            }
        }
    });

    it('have allowances that grow with the plan, Unlimited without a seat count', () => {
        const row = (id: BillingPlan) => {
            const p = pricingPlan(id);
            return [p.fairUseChats, p.members.included, p.storeLocations.included, p.whatsappNumbers.included, p.callingMinutes.included];
        };
        expect(row(BillingPlan.BASIC)).toEqual([25_000, 5, 1, 1, 1_000]);
        expect(row(BillingPlan.GROWTH)).toEqual([100_000, 10, 3, 2, 2_000]);
        expect(row(BillingPlan.SCALE)).toEqual([300_000, null, 10, 5, 5_000]);
        expect(pricingPlan(BillingPlan.SCALE).opsSeat).toBeNull();
        expect(pricingPlan(BillingPlan.ADVANCE).price).toBeNull();
    });

    it('are subscribed to after a demo, Enterprise on a contract', () => {
        expect(PLANS.map((p) => [p.id, p.selfServe, p.sales])).toEqual([
            ['BASIC', true, 'demo'],
            ['GROWTH', true, 'demo'],
            ['SCALE', true, 'demo'],
            ['ADVANCE', false, 'contract'],
        ]);
    });
});

describe('planFeatures', () => {
    it('gives Growth and above the packing assistant, messaging analytics and the public API', () => {
        const gates = (id: BillingPlan) => {
            const f = planFeatures(id);
            return [f.packing, f.messagingAnalytics, f.publicApi, f.storeScoping];
        };
        expect(gates(BillingPlan.BASIC)).toEqual([false, false, false, false]);
        expect(gates(BillingPlan.GROWTH)).toEqual([true, true, true, false]);
        expect(gates(BillingPlan.SCALE)).toEqual([true, true, true, true]);
        expect(gates(BillingPlan.ADVANCE)).toEqual([true, true, true, true]);
        expect(GATE_PLAN).toEqual({ packing: 'GROWTH', messagingAnalytics: 'GROWTH', publicApi: 'GROWTH', storeScoping: 'SCALE' });
    });

    it('gives Unlimited and Enterprise 2,000 API requests a minute, and each plan its AI drafts a day', () => {
        expect([BillingPlan.BASIC, BillingPlan.GROWTH, BillingPlan.SCALE, BillingPlan.ADVANCE].map((id) => [planFeatures(id).apiRequestsPerMinute, planFeatures(id).aiDraftsPerDay]))
            .toEqual([[600, 20], [600, 50], [2_000, 100], [2_000, 100]]);
        expect(planFeatures(BillingPlan.ADVANCE).invoiceBilling).toBe(true);
        expect(planFeatures(BillingPlan.SCALE).invoiceBilling).toBe(false);
    });
});

describe('usageCharges', () => {
    const starter = pricingPlan(BillingPlan.BASIC);
    const busy = { conversations: 40_000, callingMinutes: 1_100, members: 6, opsSeats: 2, storeLocations: 2, whatsappNumbers: 2, instagramAccounts: 3 };

    it('charges calling minutes, extra seats, packing and till seats, store locations and numbers over the plan, with GST on rupee bills', () => {
        const c = usageCharges(starter, 'INR', busy);
        expect(c.lines).toEqual([
            { key: 'callingMinutes', quantity: 100, unitPrice: 0.35, amount: 3_500 },
            { key: 'members', quantity: 1, unitPrice: 999, amount: 99_900 },
            { key: 'opsSeats', quantity: 2, unitPrice: 199, amount: 39_800 },
            { key: 'storeLocations', quantity: 1, unitPrice: 999, amount: 99_900 },
            { key: 'whatsappNumbers', quantity: 1, unitPrice: 999, amount: 99_900 },
        ]);
        expect(c.subtotal).toBe(343_000);
        expect(c.tax).toBe(61_740);
        expect(c.total).toBe(404_740);
    });

    it('never charges chats, however many, nor Instagram accounts', () => {
        const c = usageCharges(starter, 'INR', { ...NO_USAGE, conversations: 10_000_000, instagramAccounts: 4, members: 1 });
        expect(c).toEqual({ lines: [], subtotal: 0, tax: 0, total: 0 });
    });

    it('prices dollar bills in cents to the nearest cent, without GST', () => {
        const c = usageCharges(starter, 'USD', busy);
        expect(c.lines.map((l) => [l.key, l.amount])).toEqual([
            ['callingMinutes', 40],
            ['members', 1_200],
            ['opsSeats', 600],
            ['storeLocations', 1_200],
            ['whatsappNumbers', 1_200],
        ]);
        expect(c.tax).toBe(0);
        expect(c.total).toBe(4_240);
    });

    it('lets ops seats use the seats full members leave free, and charges the rest at the ops price', () => {
        const c = usageCharges(starter, 'INR', { ...NO_USAGE, members: 2, opsSeats: 4 });
        expect(c.lines).toEqual([{ key: 'opsSeats', quantity: 1, unitPrice: 199, amount: 19_900 }]);
        expect(usageCharges(starter, 'INR', { ...NO_USAGE, members: 2, opsSeats: 3 }).total).toBe(0);
    });

    it('prices Growth seats at its own fee', () => {
        const c = usageCharges(pricingPlan(BillingPlan.GROWTH), 'INR', { ...NO_USAGE, members: 12, storeLocations: 3, whatsappNumbers: 2 });
        expect(c.lines).toEqual([{ key: 'members', quantity: 2, unitPrice: 799, amount: 159_800 }]);
    });

    it('charges Unlimited no seats of either kind, only minutes, locations and numbers over its own', () => {
        const unlimited = pricingPlan(BillingPlan.SCALE);
        expect(usageCharges(unlimited, 'INR', { ...NO_USAGE, members: 400, opsSeats: 90, storeLocations: 10, whatsappNumbers: 5 }).total).toBe(0);
        expect(usageCharges(unlimited, 'USD', { ...NO_USAGE, callingMinutes: 5_500, storeLocations: 11 }).lines).toEqual([
            { key: 'callingMinutes', quantity: 500, unitPrice: 0.0024, amount: 120 },
            { key: 'storeLocations', quantity: 1, unitPrice: 12, amount: 1_200 },
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
