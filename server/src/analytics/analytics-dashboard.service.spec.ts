import { AnalyticsDashboardService } from './analytics-dashboard.service';

/** Midnight UTC `n` days ago, the way snapshot rows are dated. */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function build(rows: Array<{ date: Date; metrics: Record<string, number> }>) {
  const prisma = {
    analyticsSnapshot: {
      findMany: jest.fn().mockResolvedValue(rows.map((r) => ({ ...r, updatedAt: r.date }))),
    },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    channel: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return new AnalyticsDashboardService(prisma as any);
}

describe('AnalyticsDashboardService.getDashboard', () => {
  it('gives no rate of change when the previous period had nothing', async () => {
    const service = build([
      { date: daysAgo(1), metrics: { pixelAddToCartSessions: 4, pixelCheckoutStartedSessions: 4 } },
      { date: daysAgo(10), metrics: { pixelAddToCartSessions: 2 } },
    ]);

    const { stats } = await service.getDashboard('org_1', { range: '7d', channel: 'all' } as any);
    const change = Object.fromEntries(stats.map((s) => [s.key, s.change]));

    expect(change.totalAddToCart).toBe(100);
    // Four checkouts against none: not "0%", which read as flat.
    expect(change.totalCheckout).toBeNull();
  });

  it('calls zero against zero no change', async () => {
    const service = build([{ date: daysAgo(1), metrics: { pixelAddToCartSessions: 3 } }]);

    const { stats } = await service.getDashboard('org_1', { range: '7d', channel: 'all' } as any);

    expect(stats.find((s) => s.key === 'totalCheckout')?.change).toBe(0);
  });

  it('labels trend days day-first, never month-first', async () => {
    const service = build([{ date: daysAgo(1), metrics: { pixelAddToCartSessions: 1 } }]);

    const { trend } = await service.getDashboard('org_1', { range: '30d', channel: 'all' } as any);

    expect(trend.length).toBeGreaterThan(0);
    for (const point of trend) expect(point.label).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
  });
});
