import { ORDER_EXPORT_ROW_CAP, OrderService } from './order.service';

/**
 * The Orders page export is capped (the file is built in memory). A capped
 * file that says nothing reads as complete, so the service reports how many
 * orders matched and the controller passes that to the page.
 */

const ORG = 'org_1';

const order = (i: number) => ({
  orderNumber: i, name: `SJ${i}`, externalCreatedAt: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'), customer: null, channel: { name: 'Shopify' },
  lineItems: [], subtotalPrice: 1, totalTax: 0, totalShippingPrice: 0, totalDiscounts: 0,
  totalPrice: 1, currency: 'INR', financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
});

function build(opts: { rows: number; matched?: number }) {
  const prisma = {
    order: {
      findMany: jest.fn().mockResolvedValue(Array.from({ length: opts.rows }, (_, i) => order(i))),
      count: jest.fn().mockResolvedValue(opts.matched ?? 0),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }) },
  };
  const service = new OrderService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any,
  );
  return { service, prisma };
}

describe('OrderService.getExportData', () => {
  it('reports the full match count when the cap cut the file off', async () => {
    const { service, prisma } = build({ rows: ORDER_EXPORT_ROW_CAP, matched: 38_678 });

    const { orders, total } = await service.getExportData(ORG, {} as any);

    expect(orders).toHaveLength(ORDER_EXPORT_ROW_CAP);
    expect(total).toBe(38_678);
    expect(prisma.order.findMany.mock.calls[0][0].take).toBe(ORDER_EXPORT_ROW_CAP);
    // Counted over exactly the rows the export selected from.
    expect(prisma.order.count.mock.calls[0][0].where).toBe(
      prisma.order.findMany.mock.calls[0][0].where,
    );
  });

  it('dates an order by externalCreatedAt, else createdAt, like the dashboard report', async () => {
    const { service, prisma } = build({ rows: 1 });

    await service.getExportData(ORG, { dateFrom: '2026-09-01', dateTo: '2026-09-30' } as any);

    // A bare `externalCreatedAt` filter dropped CRM-native orders (NULL there)
    // that the dashboard's file for the same range included.
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.externalCreatedAt).toBeUndefined();
    // Under AND so a later `where.OR = search` cannot overwrite the window.
    expect(where.OR).toBeUndefined();
    const [dateWindow] = where.AND;
    expect(dateWindow.OR).toEqual([
      { externalCreatedAt: { gte: expect.any(Date), lt: expect.any(Date) } },
      { externalCreatedAt: null, createdAt: { gte: expect.any(Date), lt: expect.any(Date) } },
    ]);
    // One window for both branches, so a row cannot be in-range by one date
    // and out by the other.
    expect(dateWindow.OR[1].createdAt).toEqual(dateWindow.OR[0].externalCreatedAt);
    expect(dateWindow.OR[0].externalCreatedAt.gte < dateWindow.OR[0].externalCreatedAt.lt).toBe(true);
  });

  it('puts undated orders last so a capped file really holds the newest', async () => {
    const { service, prisma } = build({ rows: 1 });

    await service.getExportData(ORG, {} as any);

    expect(prisma.order.findMany.mock.calls[0][0].orderBy).toEqual([
      { externalCreatedAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ]);
  });

  it('does not run the extra count for a file that fits under the cap', async () => {
    const { service, prisma } = build({ rows: 12 });

    const { orders, total } = await service.getExportData(ORG, { dateFrom: '2026-09-01' } as any);

    expect(orders).toHaveLength(12);
    expect(total).toBe(12);
    expect(prisma.order.count).not.toHaveBeenCalled();
  });
});
