import { Prisma } from '@prisma/client';
import { OrderService } from './order.service';

/**
 * The Orders page's four tiles. They must count the orders the table under
 * them lists, and Total Sales must be the dashboard's Total Sales: same scope,
 * same rate guards, same "excluded" count. The two screens used to disagree on
 * the same week (15 orders excluded on one, 3 on the other).
 */

const ORG = 'org_1';

function build() {
  const prisma = {
    order: {
      count: jest.fn().mockResolvedValue(4),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    orderLineItem: { aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: 7 } }) },
    $queryRaw: jest.fn().mockResolvedValue([{ total: '30375', unconverted: BigInt(15) }]),
    organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC', currency: 'inr' }) },
  };
  const service = new OrderService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, { order: jest.fn() } as any /* commerceEvents */,
  );
  return { service, prisma };
}

/** A `$queryRaw` tagged-template call as one statement, nested fragments included. */
const queryOf = (call: any[]) => Prisma.sql(call[0] as string[], ...call.slice(1));

describe('OrderService.getComparison', () => {
  const query = { dateFrom: '2026-10-22', dateTo: '2026-10-28' } as any;

  it('counts orders by the list rule, falling back to createdAt', async () => {
    const { service, prisma } = build();
    await service.getComparison(ORG, query);

    for (const [{ where }] of prisma.order.count.mock.calls) {
      expect(where.externalCreatedAt).toBeUndefined();
      expect(where.OR).toEqual([
        { externalCreatedAt: expect.any(Object) },
        { externalCreatedAt: null, createdAt: expect.any(Object) },
      ]);
    }
  });

  it('sums sales over the dashboard scope and counts the excluded orders the same way', async () => {
    const { service, prisma } = build();
    const result = await service.getComparison(ORG, query);

    const { sql, values } = queryOf(prisma.$queryRaw.mock.calls[0]);
    // The dashboard's salesOrderWhere: cancelled out, partly refunded in.
    expect(sql).toContain('o."cancelled_at" IS NULL');
    expect(values).toEqual(expect.arrayContaining(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED']));
    // Placed-at with the createdAt fallback, not the bare external date.
    expect(sql).toContain('COALESCE(o."external_created_at", o."created_at")');
    // A rate only counts when it converts into the org currency; everything
    // else is the excluded count.
    expect(sql).toContain('UPPER(o."base_currency") =');
    expect(sql).toContain('FILTER (WHERE NOT');
    expect(values).toContain('INR');

    expect(result.totalSales).toMatchObject({ current: 30375, currency: 'INR', unconverted: 15 });
  });

  it('breaks the total down by currency over the same scope', async () => {
    const { service, prisma } = build();
    await service.getComparison(ORG, query);

    const { where } = prisma.order.groupBy.mock.calls[0][0];
    expect(where).toMatchObject({
      cancelledAt: null,
      financialStatus: { in: ['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'] },
    });
    expect(where.OR).toHaveLength(2);
  });
});
