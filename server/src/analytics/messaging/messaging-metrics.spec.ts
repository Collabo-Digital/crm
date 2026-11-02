import { Prisma } from '@prisma/client';
import { MessagingAnalyticsService } from './messaging-analytics.service';
import { attributeOrders, csvLine, estimateCost, percentile } from './messaging-metrics';

const at = (h: number) => new Date(Date.UTC(2026, 9, 20, h));

describe('percentile', () => {
    it('uses the nearest rank', () => {
        expect(percentile([], 50)).toBeNull();
        expect(percentile([30, 10, 20], 50)).toBe(20);
        expect(percentile([10, 20, 30, 40], 50)).toBe(20);
        expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    });
});

describe('attributeOrders', () => {
    it('gives each order to the latest message in the window before it', () => {
        const touches = [
            { customerId: 'c1', at: at(1), source: 'broadcast' as const, refId: 'b1' },
            { customerId: 'c1', at: at(5), source: 'automation' as const, refId: 'a1' },
            { customerId: 'c1', at: at(20), source: 'broadcast' as const, refId: 'b2' },
            { customerId: 'c2', at: at(0), source: 'broadcast' as const, refId: 'b1' },
        ];
        const orders = [
            { id: 'o1', customerId: 'c1', at: at(10), revenue: 100 },
            { id: 'o2', customerId: 'c2', at: at(30), revenue: 50 },
            { id: 'o3', customerId: 'c3', at: at(10), revenue: 70 },
        ];
        const out = attributeOrders(orders, touches, 24 * 3600_000);
        expect(out.map((x) => [x.order.id, x.touch.refId])).toEqual([['o1', 'a1']]);
        expect(attributeOrders(orders, touches, 31 * 3600_000).map((x) => x.order.id)).toEqual(['o1', 'o2']);
    });
});

describe('estimateCost', () => {
    it('prices billable messages by category and country, and counts the rest', () => {
        const rates = [
            { countryPrefix: '91', currency: 'INR', marketing: 0.86, utility: 0.115, authentication: 0.115 },
            { countryPrefix: '*', currency: 'USD', marketing: 0.025, utility: null, authentication: null },
        ];
        const r = estimateCost(
            [
                { category: 'marketing', billable: true, toDigits: '919800000001', count: 10 },
                { category: 'marketing', billable: true, toDigits: '15550000001', count: 4 },
                { category: 'utility', billable: true, toDigits: '15550000001', count: 3 },
                { category: 'service', billable: false, toDigits: '919800000001', count: 7 },
                { category: 'utility', billable: false, toDigits: '919800000001', count: 2 },
            ],
            rates,
        );
        expect(r.totals).toEqual([{ currency: 'INR', amount: 8.6 }, { currency: 'USD', amount: 0.1 }]);
        expect(r.billable).toBe(17);
        expect(r.free).toBe(9);
        expect(r.unpriced).toBe(3);
        expect(r.categories.find((c) => c.category === 'utility')).toMatchObject({ billable: 3, free: 2, unpriced: 3 });
    });
});

describe('csvLine', () => {
    it('quotes and defuses spreadsheet formulas', () => {
        expect(csvLine(['Asha, A', 'say "hi"', null, 3, '=SUM(A1)'])).toBe('"Asha, A","say ""hi""",,3,\'=SUM(A1)');
    });

    it('keeps a carriage return inside its cell, so it cannot start a row with a formula', () => {
        expect(csvLine(['Asha x\r=cmd|\' /C calc\'!A0', 'AGENT'])).toBe('"Asha x\r=cmd|\' /C calc\'!A0",AGENT');
        expect(csvLine(['\r=1+1'])).toBe('"\'\r=1+1"');
        expect(csvLine(['\t=1+1'])).toBe('\'\t=1+1');
    });
});

describe('MessagingAnalyticsService › revenue', () => {
    const period = { from: at(0), to: at(24), timeZone: 'UTC', days: 1, channelId: null };

    function build(orders: Array<{ id: string; customer_id: string; at: Date; revenue: number | null }>) {
        const queryRaw = jest.fn((sql: Prisma.Sql) => Promise.resolve(/FROM orders/.test(sql.text) ? orders : []));
        const prisma = {
            organization: { findUniqueOrThrow: jest.fn(() => Promise.resolve({ currency: 'INR' })) },
            broadcast: { findMany: jest.fn(() => Promise.resolve([])) },
            automation: { findMany: jest.fn(() => Promise.resolve([])) },
            $queryRaw: queryRaw,
        };
        return {
            service: new MessagingAnalyticsService(prisma as never),
            ordersSql: () => queryRaw.mock.calls.map(([sql]) => sql).find((sql) => /FROM orders/.test(sql.text)),
        };
    }

    it('reads sales only, as the dashboard does, and never books an unknown rate at 1', async () => {
        const { service, ordersSql } = build([]);

        await service['revenue']('org_1', period);

        const sql = ordersSql();
        expect(sql?.text).toMatch(/deleted_at IS NULL/);
        expect(sql?.text).toMatch(/cancelled_at IS NULL/);
        expect(sql?.text).toMatch(/financial_status::text IN \(\$\d+(,\s*\$\d+){2}\)/);
        expect(sql?.values).toEqual(expect.arrayContaining(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED']));
        for (const status of ['PENDING', 'AUTHORIZED', 'REFUNDED', 'VOIDED']) expect(sql?.values).not.toContain(status);
        expect(sql?.text).not.toMatch(/coalesce\(exchange_rate, 1\)/i);
        expect(sql?.text).toMatch(/exchange_rate IS NOT NULL AND upper\(base_currency\) = \$\d+/);
        expect(sql?.values).toContain('INR');
    });

    it('counts an order it cannot convert apart from the revenue', async () => {
        const { service } = build([
            { id: 'o1', customer_id: 'c1', at: at(2), revenue: 100 },
            { id: 'o2', customer_id: 'c2', at: at(3), revenue: null },
        ]);

        const revenue = await service['revenue']('org_1', period);

        expect(revenue).toMatchObject({ ordersInPeriod: 1, revenueInPeriod: 100, unconvertedOrders: 1 });
    });
});
