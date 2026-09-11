import { DashboardService } from './dashboard.service';
import type { SalesProfitRow } from './profit.util';

/**
 * The dashboard's sales and profit endpoint.
 *
 * The bug this locks down: "Total Sales" was an all-time sum of `totalPrice`
 * while "Total Profit" was a hard-coded rolling 12 months of
 * `totalPrice − shipping − discounts` that silently excluded every CRM-native
 * order (their `externalCreatedAt` is NULL). Two numbers, side by side, over
 * different populations, one of them containing no cost of goods at all.
 *
 * `$queryRaw` is a tagged template, so a mocked call receives the static SQL as
 * its first argument and the bind values after it. That is enough to assert the
 * scoping without a database.
 */

const ORG = 'org_1';

function sqlOf(call: any[]): string {
  return (call[0] as readonly string[]).join(' ');
}

function bindsOf(call: any[]): unknown[] {
  return call.slice(1);
}

function datesOf(call: any[]): Date[] {
  return bindsOf(call).filter((v): v is Date => v instanceof Date);
}

function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth())
  );
}

function profitRow(over: Partial<SalesProfitRow> = {}): SalesProfitRow {
  return {
    bucket: new Date('2026-09-01T00:00:00.000Z'),
    gross_sales: 1180,
    tax: 180,
    shipping: 0,
    net_sales_gross: 1000,
    refunded_net: 0,
    line_net: 1000,
    line_net_with_cost: 1000,
    cogs_gross: 600,
    orders: 2,
    ...over,
  };
}

/**
 * `getSalesAndProfit` issues three raw queries in a fixed order: this window's
 * sales rows, this window's new customers, then the preceding window's sales
 * rows for the trend.
 */
function build(opts: {
  rows?: SalesProfitRow[];
  customers?: Array<{ bucket: Date; count: number }>;
  previous?: SalesProfitRow[];
  timezone?: string;
  /** Rows behind `totals.salesByCurrency`. Defaults to a single-currency window. */
  currencies?: Array<{ currency: string; _sum: { totalPrice: unknown }; _count: { _all: number } }>;
  /** The org's reporting currency — what every figure is converted into. */
  currency?: string;
  /** Orders excluded from the totals because their FX rate never resolved. */
  unconvertedOrders?: number;
} = {}) {
  const $queryRaw = jest
    .fn()
    .mockResolvedValueOnce(opts.rows ?? [profitRow()])
    .mockResolvedValueOnce(opts.customers ?? [])
    .mockResolvedValueOnce(opts.previous ?? []);

  const groupBy = jest
    .fn()
    .mockResolvedValue(
      opts.currencies ?? [{ currency: 'INR', _sum: { totalPrice: 1270 }, _count: { _all: 1 } }],
    );

  const prisma = {
    $queryRaw,
    order: {
      // Pre-conversion make-up behind `totals.salesByCurrency`.
      groupBy,
      // Orders whose FX rate never resolved, excluded from the converted CTE.
      count: jest.fn().mockResolvedValue(opts.unconvertedOrders ?? 0),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        timezone: opts.timezone ?? 'UTC',
        currency: opts.currency ?? 'INR',
        lowStockThreshold: 10,
      }),
    },
  };

  return {
    prisma,
    $queryRaw,
    groupBy,
    service: new DashboardService(prisma as any),
  };
}

describe('DashboardService.getSalesAndProfit', () => {
  describe('scoping', () => {
    it('windows on COALESCE(externalCreatedAt, createdAt) so offline orders are not dropped', async () => {
      const { service, $queryRaw } = build();
      await service.getSalesAndProfit(ORG, {});

      const sql = sqlOf($queryRaw.mock.calls[0]);
      expect(sql).toContain('COALESCE(o."external_created_at", o."created_at")');
      // The old filter was a bare `external_created_at >= …`, which never
      // matches a NULL — so every manual order fell out of the profit chart
      // while still counting towards the sales card beside it.
      expect(sql).not.toMatch(/o\."external_created_at"\s*>=/);
    });

    it('excludes cancelled and soft-deleted orders', async () => {
      const { service, $queryRaw } = build();
      await service.getSalesAndProfit(ORG, {});

      const sql = sqlOf($queryRaw.mock.calls[0]);
      expect(sql).toContain('o."cancelled_at" IS NULL');
      expect(sql).toContain('o."deleted_at"   IS NULL');
    });

    it('scopes to the organization', async () => {
      const { service, $queryRaw } = build();
      await service.getSalesAndProfit(ORG, {});

      expect(bindsOf($queryRaw.mock.calls[0])).toContain(ORG);
    });

    it('defaults to twelve months, anchored to the start of a month', async () => {
      const { service, $queryRaw } = build();
      const { period } = await service.getSalesAndProfit(ORG, {});
      const from = new Date(period.from);
      const to = new Date(period.to);

      expect(period.label).toBe('Last 12 months');
      // Measuring "12 months" as now − 365 days starts the window mid-month, so
      // the first bar covers a part-month and reads as a slump that never
      // happened — and the series runs to a thirteenth bucket.
      expect(from.getUTCDate()).toBe(1);
      expect(from.getUTCHours()).toBe(0);
      expect(monthsBetween(from, to)).toBe(11);
      expect(datesOf($queryRaw.mock.calls[0]).length).toBeGreaterThan(0);
    });

    it('anchors the 30-day range to the start of a day', async () => {
      const { service } = build();
      const { period } = await service.getSalesAndProfit(ORG, { range: '30d' });
      const from = new Date(period.from);

      expect(period.label).toBe('Last 30 days');
      expect(from.getUTCHours()).toBe(0);
      expect(from.getUTCMinutes()).toBe(0);
      // 30 daily buckets: 29 whole days plus today, still in progress.
      const days = (new Date(period.to).getTime() - from.getTime()) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(29);
      expect(days).toBeLessThan(30);
    });

    it('buckets in the organization timezone, not the server one', async () => {
      // Deployments run UTC, so an IST merchant's late-evening sales otherwise
      // file into the previous month.
      const { service, $queryRaw } = build({ timezone: 'Asia/Kolkata' });
      await service.getSalesAndProfit(ORG, {});

      expect(bindsOf($queryRaw.mock.calls[0])).toContain('Asia/Kolkata');
      expect(sqlOf($queryRaw.mock.calls[0])).toContain('AT TIME ZONE');
    });

    it('compares against the immediately preceding window of equal length', async () => {
      const { service, $queryRaw } = build();
      await service.getSalesAndProfit(ORG, { range: '30d' });

      const current = datesOf($queryRaw.mock.calls[0]);
      const prior = datesOf($queryRaw.mock.calls[2]);

      const currentFrom = Math.min(...current.map((d) => d.getTime()));
      const priorTo = Math.max(...prior.map((d) => d.getTime()));

      // The previous window ends exactly where this one begins.
      expect(priorTo).toBe(currentFrom);
    });

    it('narrows by channel only when one is given', async () => {
      const without = build();
      await without.service.getSalesAndProfit(ORG, {});
      expect(bindsOf(without.$queryRaw.mock.calls[0])).not.toContain('ch_1');

      const withChannel = build();
      await withChannel.service.getSalesAndProfit(ORG, { channelId: 'ch_1' });
      const fragment = bindsOf(withChannel.$queryRaw.mock.calls[0]).find(
        (v: any) => v?.values?.includes?.('ch_1'),
      );
      expect(fragment).toBeDefined();
    });
  });

  describe('reported figures', () => {
    it('reports gross profit as net sales minus COGS', async () => {
      const { service } = build({ rows: [profitRow()] });
      const { totals } = await service.getSalesAndProfit(ORG, {});

      expect(totals.netSales).toBe(1000);
      expect(totals.cogs).toBe(600);
      expect(totals.grossProfit).toBe(400);
      expect(totals.grossMarginPct).toBe(40);
    });

    it('does not report profit equal to revenue for an offline order', async () => {
      // The regression in one line. A manual order has totalShippingPrice 0 and
      // totalDiscounts 0, so the old formula reduced to profit === revenue.
      const { service } = build({
        rows: [profitRow({ shipping: 0, gross_sales: 1000, tax: 0 })],
      });
      const { totals } = await service.getSalesAndProfit(ORG, {});

      expect(totals.grossProfit).not.toBe(totals.netSales);
      expect(totals.grossProfit).toBe(400);
    });

    it('returns null profit and no trend when nothing sold has a cost', async () => {
      const { service } = build({
        rows: [profitRow({ line_net_with_cost: 0, cogs_gross: 0 })],
      });
      const { totals, profitTrend } = await service.getSalesAndProfit(ORG, {});

      expect(totals.grossProfit).toBeNull();
      expect(totals.grossMarginPct).toBeNull();
      expect(totals.costCoverage).toBe(0);
      // Sales are still knowable — only profit is not.
      expect(totals.netSales).toBe(1000);
      expect(profitTrend).toBeNull();
    });

    it('publishes cost coverage so a partial figure is never read as a whole one', async () => {
      const { service } = build({
        rows: [profitRow({ line_net_with_cost: 500, cogs_gross: 300 })],
      });
      const { totals } = await service.getSalesAndProfit(ORG, {});

      expect(totals.costCoverage).toBe(0.5);
      expect(totals.grossProfit).toBe(200);
      expect(totals.grossMarginPct).toBe(40);
    });

    it('trends gross profit against the preceding window', async () => {
      const { service } = build({
        rows: [profitRow()],                                  // profit 400
        previous: [profitRow({ cogs_gross: 800 })],           // profit 200
      });
      const { profitTrend } = await service.getSalesAndProfit(ORG, {});

      expect(profitTrend).toEqual({
        current: 400,
        previous: 200,
        change: { percentage: 100, direction: 'up' },
      });
    });

    it('keys buckets by year-month, since the labels collide', async () => {
      const { service } = build({
        rows: [
          profitRow({ bucket: new Date('2025-09-01T00:00:00.000Z') }),
          profitRow({ bucket: new Date('2026-09-01T00:00:00.000Z') }),
        ],
      });
      const { data } = await service.getSalesAndProfit(ORG, {});

      expect(data.map((d) => d.bucket)).toEqual(['Sep', 'Sep']);
      expect(data.map((d) => d.bucketKey)).toEqual(['2025-09', '2026-09']);
    });

    it('totals exactly what the bars show', async () => {
      const { service } = build({
        rows: [
          profitRow({ bucket: new Date('2026-08-01T00:00:00.000Z') }),
          profitRow({ bucket: new Date('2026-09-01T00:00:00.000Z'), net_sales_gross: 500, line_net: 500, line_net_with_cost: 500, cogs_gross: 200 }),
        ],
      });
      const { data, totals } = await service.getSalesAndProfit(ORG, {});

      expect(totals.netSales).toBe(data.reduce((s, d) => s + d.netSales, 0));
      expect(totals.cogs).toBe(data.reduce((s, d) => s + d.cogs, 0));
      expect(totals.grossProfit).toBe(700);
    });

    it('attaches new customers to their bucket and leaves the rest at zero', async () => {
      const { service } = build({
        rows: [
          profitRow({ bucket: new Date('2026-08-01T00:00:00.000Z') }),
          profitRow({ bucket: new Date('2026-09-01T00:00:00.000Z') }),
        ],
        customers: [{ bucket: new Date('2026-09-01T00:00:00.000Z'), count: 7 }],
      });
      const { data, totals } = await service.getSalesAndProfit(ORG, {});

      expect(data.map((d) => d.newCustomers)).toEqual([0, 7]);
      expect(totals.newCustomers).toBe(7);
    });

    it('survives a window with no sales at all', async () => {
      const { service } = build({ rows: [] });
      const { data, totals, profitTrend } = await service.getSalesAndProfit(ORG, {});

      expect(data).toEqual([]);
      expect(totals.netSales).toBe(0);
      expect(totals.grossProfit).toBeNull();
      expect(profitTrend).toBeNull();
    });
  });

  /**
   * `exchange_rate` only means anything alongside `base_currency`: it was
   * captured against whatever the org currency was AT THE TIME. Changing the
   * org currency does not restate history, so every stored rate still targets
   * the old one. Summing those products unchanged and labelling the result with
   * the NEW currency is how switching INR→USD reported an unchanged
   * ₹9,84,955.50 as "$984,955.50" (DEV, 2026-09-05).
   */
  describe('reporting currency changes', () => {
    it('only sums orders whose stored rate targets the current reporting currency', async () => {
      const { service, $queryRaw } = build({ currency: 'USD' });

      await service.getSalesAndProfit(ORG, {});

      const sql = sqlOf($queryRaw.mock.calls[0]);
      expect(sql).toContain('base_currency');
      expect(bindsOf($queryRaw.mock.calls[0])).toContain('USD');
    });

    it('counts the orders it had to leave out rather than dropping them silently', async () => {
      const { service, prisma } = build({ currency: 'USD', unconvertedOrders: 3 });

      const { totals } = await service.getSalesAndProfit(ORG, {});

      expect(totals.unconvertedOrders).toBe(3);
      // Both reasons an order cannot be converted: no rate, and a rate that
      // targets a currency the org no longer reports in.
      const where = prisma.order.count.mock.calls[0][0].where;
      expect(where.OR).toEqual(
        expect.arrayContaining([
          { exchangeRate: null },
          expect.objectContaining({ baseCurrency: expect.objectContaining({ not: 'USD' }) }),
        ]),
      );
    });
  });
});
