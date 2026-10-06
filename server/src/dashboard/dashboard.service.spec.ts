import { DashboardService, REPORT_ROW_CAP } from './dashboard.service';
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

/** Wall-clock parts of an instant as read in IST. */
function istParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') % 24,
    minute: pick('minute'),
  };
}

function monthsBetween(from: Date, to: Date): number {
  const a = istParts(from);
  const b = istParts(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
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

    it('defaults to twelve months, anchored to 00:00 IST on the 1st', async () => {
      const { service, $queryRaw } = build();
      const { period } = await service.getSalesAndProfit(ORG, {});
      const from = new Date(period.from);
      const to = new Date(period.to);

      expect(period.label).toBe('Last 12 months');
      // Measuring "12 months" as now − 365 days starts the window mid-month, so
      // the first bar covers a part-month and reads as a slump that never
      // happened — and the series runs to a thirteenth bucket.
      expect(istParts(from)).toMatchObject({ day: 1, hour: 0, minute: 0 });
      expect(monthsBetween(from, to)).toBe(11);
      expect(datesOf($queryRaw.mock.calls[0]).length).toBeGreaterThan(0);
    });

    it('covers 30 full days plus today for the 30-day range, from 00:00 IST', async () => {
      const { service } = build();
      const { period } = await service.getSalesAndProfit(ORG, { range: '30d' });
      const from = new Date(period.from);

      expect(period.label).toBe('Last 30 days');
      expect(istParts(from)).toMatchObject({ hour: 0, minute: 0 });
      const days = (new Date(period.to).getTime() - from.getTime()) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(30);
      expect(days).toBeLessThan(31);
    });

    it('covers 7 full days plus today for the 7-day range, from 00:00 IST', async () => {
      const { service } = build();
      const { period } = await service.getSalesAndProfit(ORG, { range: '7d' });
      const from = new Date(period.from);

      expect(period.label).toBe('Last 7 days');
      // Midnight IST is 18:30 UTC the evening before. Starting at UTC midnight
      // (05:30 IST) dropped each window's first morning of orders.
      expect(istParts(from)).toMatchObject({ hour: 0, minute: 0 });
      expect(from.getUTCHours()).toBe(18);
      expect(from.getUTCMinutes()).toBe(30);
      // Same span as the Orders page, which sends today − 7 as its dateFrom.
      const days = (new Date(period.to).getTime() - from.getTime()) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(7);
      expect(days).toBeLessThan(8);
    });

    it('buckets in the organization timezone, not the server one', async () => {
      // Deployments run UTC, so an IST merchant's late-evening sales otherwise
      // file into the previous month.
      const { service, $queryRaw } = build({ timezone: 'Asia/Kolkata' });
      await service.getSalesAndProfit(ORG, {});

      expect(bindsOf($queryRaw.mock.calls[0])).toContain('Asia/Kolkata');
      expect(sqlOf($queryRaw.mock.calls[0])).toContain('AT TIME ZONE');
    });

    it('reads the untouched UTC default as IST', async () => {
      const { service, $queryRaw } = build({ timezone: 'UTC' });
      const { period } = await service.getSalesAndProfit(ORG, { range: '7d' });

      expect(period.timezone).toBe('Asia/Kolkata');
      expect(bindsOf($queryRaw.mock.calls[0])).toContain('Asia/Kolkata');
    });

    it('keeps an explicitly-set non-UTC timezone', async () => {
      const { service } = build({ timezone: 'Asia/Tokyo' });
      const { period } = await service.getSalesAndProfit(ORG, { range: '7d' });

      expect(period.timezone).toBe('Asia/Tokyo');
      // 00:00 JST is 15:00 UTC the day before.
      expect(new Date(period.from).getUTCHours()).toBe(15);
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

/**
 * The CSV / JSON downloads. The dashboard sends `range`, but the export read
 * only `dateFrom`/`dateTo` — so every download loaded the org's whole order
 * history with no row limit, outran the client timeout on a large store and
 * surfaced as an intermittent "Failed to export".
 */
describe('DashboardService.getReportData', () => {
  function buildReport(opts: { rows?: number; matched?: number } = {}) {
    const findMany = jest.fn().mockResolvedValue(
      Array.from({ length: opts.rows ?? 0 }, (_, i) => reportOrder(i)),
    );
    const count = jest.fn().mockResolvedValue(opts.matched ?? 0);
    const prisma = {
      order: { findMany, count },
      organization: {
        findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC', currency: 'INR' }),
      },
    };
    return { findMany, count, service: new DashboardService(prisma as any) };
  }

  const reportOrder = (i: number) => ({
    orderNumber: i, name: `SJ${i}`, externalCreatedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'), customer: null, channel: { name: 'Shopify' },
    lineItems: [], subtotalPrice: 1, totalTax: 0, totalShippingPrice: 0, totalDiscounts: 0,
    totalPrice: 1, currency: 'INR', financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
  });

  it('builds the JSON export over one window, resolved once', async () => {
    const { service, findMany } = buildReport();
    const overviewSpy = jest
      .spyOn(service, 'getOverview')
      .mockResolvedValue({ totalSales: 0, totalOrders: 0, totalCustomers: 0, totalProducts: 0 } as any);
    const organizationLookup = (service as any).prisma.organization.findUnique as jest.Mock;

    const { period } = await service.getExportReport(ORG, { range: '7d' });

    // Each method resolving its own window would end at its own `new Date()`
    // and hit the organisation table once each.
    expect(organizationLookup).toHaveBeenCalledTimes(1);
    const windowGivenToOverview = overviewSpy.mock.calls[0][2];
    expect(windowGivenToOverview).toBeDefined();
    expect(period).toEqual({
      from: windowGivenToOverview!.from.toISOString(),
      to: windowGivenToOverview!.to.toISOString(),
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('exports only the period the dashboard is showing', async () => {
    const { service, findMany } = buildReport();
    const { period } = await service.getReportData(ORG, { range: '7d' });

    const where = findMany.mock.calls[0][0].where;
    // `placedBetween`: Shopify time, falling back to the CRM row time, so
    // CRM-created orders are in the file too.
    expect(where.OR).toEqual([
      { externalCreatedAt: { gte: expect.any(Date), lt: expect.any(Date) } },
      { externalCreatedAt: null, createdAt: { gte: expect.any(Date), lt: expect.any(Date) } },
    ]);
    const from: Date = where.OR[0].externalCreatedAt.gte;
    const days = (where.OR[0].externalCreatedAt.lt.getTime() - from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThan(8);
    expect(period).toEqual({ from: from.toISOString(), to: expect.any(String) });
  });

  it('stays unbounded for a request with no range and no dates', async () => {
    // The Orders page's "All time" export calls this endpoint with nothing.
    const { service, findMany } = buildReport();
    const { period } = await service.getReportData(ORG, {});

    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('OR');
    expect(period).toBeNull();
  });

  it('never loads more than the row cap', async () => {
    const { service, findMany } = buildReport();
    await service.getReportData(ORG, {});
    await service.getReportData(ORG, { range: '12m' });

    expect(findMany.mock.calls.map((c) => c[0].take)).toEqual([REPORT_ROW_CAP, REPORT_ROW_CAP]);
  });

  it('reports the full match count when the cap cut the file off', async () => {
    const { service, count, findMany } = buildReport({ rows: REPORT_ROW_CAP, matched: 10_871 });
    const { orders, total } = await service.getReportData(ORG, { range: '12m' });

    expect(orders).toHaveLength(REPORT_ROW_CAP);
    expect(total).toBe(10_871);
    // Counted over exactly the rows the export selected from.
    expect(count.mock.calls[0][0].where).toBe(findMany.mock.calls[0][0].where);
  });

  it('does not run the extra count for a file that fits under the cap', async () => {
    const { service, count } = buildReport({ rows: 3 });
    const { total } = await service.getReportData(ORG, { range: '7d' });

    expect(total).toBe(3);
    expect(count).not.toHaveBeenCalled();
  });

  it('scopes to the organization and skips deleted orders', async () => {
    const { service, findMany } = buildReport();
    await service.getReportData(ORG, { range: '30d', channelId: 'ch_1' });

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      deletedAt: null,
      channelId: 'ch_1',
    });
  });
});
