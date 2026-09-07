import { OrderService } from './order.service';

/**
 * Vendor-scoped order stats. An order can carry several vendors' lines, so the
 * whole point of these four metrics is that they measure ONE vendor's lines.
 * Summing the order total, or counting whole orders, would hand a vendor the
 * revenue and the workload of everyone else on the same order. These tests pin
 * the predicates, not the SQL dialect.
 */

const ORG = 'org_1';
const VENDOR = 'Snowboard Vendor';

function build() {
  const prisma = {
    order: { count: jest.fn().mockResolvedValue(3) },
    orderLineItem: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: 9 } }),
    },
    // Both raw queries go through this one mock; the pending query reads
    // `count` and the sales query reads `value`, so one shape serves both.
    $queryRaw: jest.fn().mockResolvedValue([{ count: 2, value: 1500 }]),
  };
  const service = new OrderService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { service, prisma };
}

/** Flattens a `$queryRaw` tagged-template call back into its SQL text. */
const sqlOf = (call: any[]) => (call[0] as string[]).join('?');
/** The values bound into a `$queryRaw` tagged-template call. */
const boundOf = (call: any[]) => JSON.stringify(call.slice(1));

describe('OrderService.getVendorComparison', () => {
  const query = { dateFrom: '2026-08-01', dateTo: '2026-08-31' } as any;

  it('counts only orders carrying a line from this vendor', async () => {
    const { service, prisma } = build();

    await service.getVendorComparison(ORG, query, VENDOR);

    expect(prisma.order.count).toHaveBeenCalledTimes(2); // current + previous
    for (const [args] of prisma.order.count.mock.calls) {
      expect(args.where).toMatchObject({
        organizationId: ORG,
        deletedAt: null,
        lineItems: { some: { vendor: VENDOR } },
      });
    }
  });

  it('sums units sold from this vendor line items only', async () => {
    const { service, prisma } = build();

    await service.getVendorComparison(ORG, query, VENDOR);

    expect(prisma.orderLineItem.aggregate).toHaveBeenCalledTimes(2);
    for (const [args] of prisma.orderLineItem.aggregate.mock.calls) {
      expect(args.where.vendor).toBe(VENDOR);
      expect(args.where.order).toMatchObject({
        organizationId: ORG,
        deletedAt: null,
      });
      expect(args._sum).toEqual({ quantity: true });
    }
  });

  it('counts pending from this vendor unshipped units, not the order status', async () => {
    const { service, prisma } = build();

    await service.getVendorComparison(ORG, query, VENDOR);

    const pending = prisma.$queryRaw.mock.calls.filter((c) =>
      sqlOf(c).includes('fulfilled_quantity'),
    );
    expect(pending).toHaveLength(2);
    for (const call of pending) {
      const sql = sqlOf(call);
      // The column-to-column compare is the whole reason this is raw SQL.
      expect(sql).toContain('li."fulfilled_quantity" < li."quantity"');
      // One vendor can hold several lines on a single order.
      expect(sql).toContain('COUNT(DISTINCT o."id")');
      // An order that ONLY another vendor is behind on is not this vendor's
      // pending work, so the order-level status must not appear here.
      expect(sql).not.toContain('fulfillment_status');
      expect(boundOf(call)).toContain(VENDOR);
      expect(boundOf(call)).toContain(ORG);
    }
  });

  it('sums sales as price x quantity over this vendor paid lines', async () => {
    const { service, prisma } = build();

    await service.getVendorComparison(ORG, query, VENDOR);

    const sales = prisma.$queryRaw.mock.calls.filter((c) =>
      sqlOf(c).includes('SUM('),
    );
    expect(sales).toHaveLength(2);
    for (const call of sales) {
      const sql = sqlOf(call);
      expect(sql).toContain('SUM(li."price" * li."quantity")');
      // Same payment rule as the org-wide tile, so Total Sales keeps one
      // meaning across roles.
      expect(sql).toContain("IN ('PAID', 'PARTIALLY_PAID')");
      expect(boundOf(call)).toContain(VENDOR);
    }
  });

  it('binds the vendor instead of inlining it into the SQL', async () => {
    const { service, prisma } = build();

    await service.getVendorComparison(ORG, query, "Bobby'; DROP TABLE orders;--");

    expect(prisma.$queryRaw.mock.calls.length).toBeGreaterThan(0);
    for (const call of prisma.$queryRaw.mock.calls) {
      expect(sqlOf(call)).not.toContain('DROP TABLE');
    }
  });

  it('returns the same shape as the org-wide comparison', async () => {
    const { service } = build();

    const stats = await service.getVendorComparison(ORG, query, VENDOR);

    expect(Object.keys(stats).sort()).toEqual([
      'pendingOrders',
      'period',
      'totalNewOrders',
      'totalProductsSold',
      'totalSales',
    ]);
    for (const key of [
      'totalNewOrders',
      'pendingOrders',
      'totalSales',
      'totalProductsSold',
    ] as const) {
      expect(stats[key]).toEqual({
        current: expect.anything(),
        previous: expect.anything(),
        change: {
          percentage: expect.any(Number),
          direction: expect.stringMatching(/^(up|down|same)$/),
        },
      });
    }
    expect(stats.totalNewOrders.current).toBe(3);
    expect(stats.pendingOrders.current).toBe(2);
    expect(stats.totalSales.current).toBe(1500);
    expect(stats.totalProductsSold.current).toBe(9);
  });

  it('reports a previous window of equal length ending just before the current', async () => {
    const { service } = build();

    const { period } = await service.getVendorComparison(ORG, query, VENDOR);

    const curFrom = new Date(period.current.from).getTime();
    const curTo = new Date(period.current.to).getTime();
    // `previous` is null only for an unbounded ("All Time") window; this test
    // passes an explicit range, so it must be present.
    expect(period.previous).not.toBeNull();
    const prevFrom = new Date(period.previous!.from).getTime();
    expect(new Date(period.previous!.to).getTime()).toBe(curFrom - 1);
    expect(curTo - curFrom).toBe(curFrom - prevFrom);
  });
});
