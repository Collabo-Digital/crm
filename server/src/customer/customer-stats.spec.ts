import { CustomerService } from './customer.service';

/**
 * "New customers this month" used the server's month (UTC in production) and
 * only Shopify's `externalCreatedAt`, so an IST sign-up at 02:00 on the 1st
 * landed in the previous month and walk-in customers never counted.
 */
describe('CustomerService.getStats — new customers', () => {
  afterEach(() => jest.useRealTimers());

  it("counts by the org's month and includes customers created in the CRM", async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-14T09:00:00Z'));
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }) },
      customer: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalSpent: 0 }, _avg: { totalSpent: 0 } }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ avg: 0 }]),
    };
    const service = new CustomerService(prisma as any, {} as any);

    await service.getStats('org_1');

    const thisMonth = prisma.customer.count.mock.calls[1][0].where;
    const lastMonth = prisma.customer.count.mock.calls[2][0].where;
    // 1 Oct 00:00 IST is 30 Sep 18:30 UTC (an untouched 'UTC' org reports in IST).
    const octStart = new Date('2026-09-30T18:30:00Z');
    expect(thisMonth.OR).toEqual([
      { externalCreatedAt: { gte: octStart } },
      { externalCreatedAt: null, createdAt: { gte: octStart } },
    ]);
    expect(lastMonth.OR[1]).toEqual({
      externalCreatedAt: null,
      createdAt: { gte: new Date('2026-08-31T18:30:00Z'), lt: octStart },
    });
  });
});
