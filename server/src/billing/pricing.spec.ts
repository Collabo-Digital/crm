import { BillingPlan } from '@prisma/client';

import { periodOf, periodRange, previousPeriod, pricingPlan, usageCharges } from './pricing';

describe('usageCharges', () => {
    const basic = pricingPlan(BillingPlan.BASIC);
    const busy = { conversations: 6_234, callingMinutes: 1_100, members: 7, instagramAccounts: 1 };

    it('charges what is over each allowance, plus Instagram, with GST on rupee bills', () => {
        const c = usageCharges(basic, 'INR', busy);
        expect(c.lines).toEqual([
            { key: 'conversations', quantity: 1_234, unitPrice: 0.2, amount: 24_680 },
            { key: 'callingMinutes', quantity: 100, unitPrice: 0.35, amount: 3_500 },
            { key: 'members', quantity: 2, unitPrice: 1000, amount: 200_000 },
            { key: 'instagram', quantity: 1, unitPrice: 799, amount: 79_900 },
        ]);
        expect(c.subtotal).toBe(308_080);
        expect(c.tax).toBe(55_454);
        expect(c.total).toBe(363_534);
    });

    it('prices dollar bills in cents to the nearest cent, without GST', () => {
        const c = usageCharges(basic, 'USD', busy);
        expect(c.lines.map((l) => l.amount)).toEqual([296, 40, 2_400, 999]);
        expect(c.tax).toBe(0);
        expect(c.total).toBe(3_735);
    });

    it('charges nothing within the allowances', () => {
        const c = usageCharges(basic, 'INR', { conversations: 5_000, callingMinutes: 1_000, members: 5, instagramAccounts: 0 });
        expect(c).toEqual({ lines: [], subtotal: 0, tax: 0, total: 0 });
    });

    it('has Growth allowances of its own', () => {
        const c = usageCharges(pricingPlan(BillingPlan.GROWTH), 'INR', { conversations: 100_001, callingMinutes: 2_000, members: 10, instagramAccounts: 0 });
        expect(c.lines).toEqual([{ key: 'conversations', quantity: 1, unitPrice: 0.1, amount: 10 }]);
    });

    it('leaves Enterprise to its contract', () => {
        expect(usageCharges(pricingPlan(BillingPlan.ADVANCE), 'INR', { conversations: 1e7, callingMinutes: 1e5, members: 400, instagramAccounts: 3 }).total).toBe(0);
    });
});

describe('billing periods', () => {
    it('are calendar months in UTC', () => {
        expect(periodOf(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
        expect(previousPeriod(new Date('2027-01-01T00:30:00Z'))).toBe('2026-12');
        expect(periodRange('2026-12')).toEqual({ start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') });
    });
});
