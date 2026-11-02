import { ChannelPlatform, Prisma } from '@prisma/client';
import { ShopifyAnalyticsService } from './shopify-analytics.service';

/** Keys the Web Pixel and cart/checkout webhook roll-ups write onto the same daily rows. */
const ROLL_UP_KEYS = [
  'byProduct',
  'byPage',
  'pixelSessions',
  'pixelPageviews',
  'pixelAddToCartSessions',
  'pixelCheckoutStartedSessions',
  'pixelCheckoutCompletedSessions',
  'cartsCreatedFromWebhook',
  'checkoutsStartedFromWebhook',
  'ordersFromWebhook',
];

/** A Shopify channel with no usable token, so a refresh takes the order-derived path. */
function build() {
  const executeRaw = jest.fn<Promise<number>, [Prisma.Sql]>(() => Promise.resolve(1));
  const prisma = {
    channel: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'ch_1', organizationId: 'org_1', platform: ChannelPlatform.SHOPIFY, externalStoreUrl: null }),
      ),
    },
    order: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { externalCreatedAt: new Date(), createdAt: new Date(), totalPrice: 500, currency: 'INR', financialStatus: 'PAID' },
        ]),
      ),
    },
    analyticsSnapshot: { upsert: jest.fn(() => Promise.resolve({})) },
    $executeRaw: executeRaw,
  };
  const oauth = { getAccessToken: jest.fn(() => Promise.reject(new Error('token revoked'))) };
  const service = new ShopifyAnalyticsService(prisma as never, oauth as never, {} as never);
  return { service, prisma, writes: () => executeRaw.mock.calls.map(([sql]) => sql) };
}

function metricsOf(sql: Prisma.Sql): Record<string, unknown> {
  const json = sql.values.find((v): v is string => typeof v === 'string' && v.startsWith('{'));
  return JSON.parse(json ?? '{}') as Record<string, unknown>;
}

describe('ShopifyAnalyticsService › refresh writes', () => {
  it('keeps the pixel and webhook counts on a day it refreshes, replacing only its own keys', async () => {
    const { service, prisma, writes } = build();

    await service.refreshForChannel('ch_1', 2);

    // A Prisma upsert replaces the whole metrics blob.
    expect(prisma.analyticsSnapshot.upsert).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(2);
    const today = writes().find((sql) => metricsOf(sql).date === new Date().toISOString().slice(0, 10));
    expect(today?.text).toMatch(/ON CONFLICT \("channel_id", "date", "granularity"\)\s+DO UPDATE/);
    expect(today?.text).toMatch(/"metrics" = \("analytics_snapshots"\."metrics" - \$\d+::text\[\]\) \|\| EXCLUDED\."metrics"/);
    const replaced = today?.values.find((v): v is string[] => Array.isArray(v)) ?? [];
    expect(replaced).toEqual(expect.arrayContaining(['orders', 'revenue', 'currency', 'sessions', 'byReferrer']));
    for (const key of ROLL_UP_KEYS) expect(replaced).not.toContain(key);
    expect(metricsOf(today!)).toMatchObject({ orders: 1, revenue: 500, currency: 'INR' });
  });
});
