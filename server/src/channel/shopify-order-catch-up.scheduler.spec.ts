import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { ShopifyOrderCatchUpScheduler } from './shopify-order-catch-up.scheduler';
import { ShopifySyncService } from './shopify-sync.service';

const HOUR = 60 * 60 * 1000;

type Channel = { id: string; organizationId: string; connectedAt: Date | null; orderCatchUpAt: Date | null };

function order(id: number, createdAgoMs: number) {
  const at = new Date(Date.now() - createdAgoMs).toISOString();
  return { id, created_at: at, updated_at: at, checkout_token: `tok_${id}` };
}

/**
 * `pages` is what Shopify returns per channel (or the error it fails with);
 * upsertOrder stores each order, so a later run sees it as already stored.
 */
function build(channels: Channel[], pages: Record<string, unknown[][] | Error>) {
  const stored = new Map<string, Date>();
  // The scheduler's "due" filter: never caught up, or not since `lte`.
  const due = (c: Channel, where: any) =>
    where.OR.some((w: any) =>
      w.orderCatchUpAt === null ? c.orderCatchUpAt === null : c.orderCatchUpAt !== null && c.orderCatchUpAt <= w.orderCatchUpAt.lte,
    );
  const prisma = {
    channel: {
      findMany: jest.fn(async ({ where }: any) => channels.filter((c) => due(c, where)).map((c) => ({ id: c.id }))),
      findFirst: jest.fn(async ({ where }: any) => {
        const c = channels.find((x) => x.id === where.id && due(x, where));
        return c ? { ...c } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(channels.find((c) => c.id === where.id)!, data);
        return {};
      }),
    },
    order: {
      findMany: jest.fn(async ({ where }: any) =>
        where.externalId.in
          .filter((id: string) => stored.has(id))
          .map((id: string) => ({ externalId: id, externalUpdatedAt: stored.get(id) })),
      ),
    },
  };
  const redis = { acquireLock: jest.fn().mockResolvedValue(true), del: jest.fn().mockResolvedValue(undefined) };
  const sync = {
    ordersUpdatedSince: jest.fn((channelId: string, _since: Date) =>
      (async function* () {
        const p = pages[channelId] ?? [[]];
        if (p instanceof Error) throw p;
        yield* p;
      })(),
    ),
    upsertOrder: jest.fn(async (_channelId: string, _orgId: string, so: any) => {
      stored.set(String(so.id), new Date(so.updated_at));
    }),
  };
  const checkouts = { markCompleted: jest.fn().mockResolvedValue(undefined) };
  const scheduler = new ShopifyOrderCatchUpScheduler(
    prisma as any, redis as any, sync as any, checkouts as any, { get: jest.fn() } as any,
  );
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn((scheduler as any).logger, level).mockImplementation(() => undefined);
  }
  return { scheduler, prisma, redis, sync, checkouts, stored };
}

const store = (id: string, extra: Partial<Channel> = {}): Channel => ({
  id, organizationId: 'org_1', connectedAt: new Date(Date.now() - 30 * 24 * HOUR), orderCatchUpAt: null, ...extra,
});

describe('ShopifyOrderCatchUpScheduler', () => {
  it('recovers an order whose webhook never came: completes its checkout and writes it as the webhook would', async () => {
    const lost = order(9001, HOUR);
    const { scheduler, sync, checkouts } = build([store('ch_1')], { ch_1: [[lost]] });

    await scheduler.tick();

    expect(checkouts.markCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: 'ch_1' }), lost);
    expect(sync.upsertOrder).toHaveBeenCalledWith('ch_1', 'org_1', lost, { live: true });
  });

  it('raises order events only for orders created in the last 24 hours, and saves older ones silently', async () => {
    const recent = order(9001, 23 * HOUR);
    const old = order(9002, 3 * 24 * HOUR);
    const { scheduler, sync } = build([store('ch_1')], { ch_1: [[recent, old]] });

    await scheduler.tick();

    expect(sync.upsertOrder).toHaveBeenCalledWith('ch_1', 'org_1', recent, { live: true });
    expect(sync.upsertOrder).toHaveBeenCalledWith('ch_1', 'org_1', old, { live: false });
  });

  it("writes an order once: a later run, or one after the order's webhook, leaves it alone", async () => {
    const lost = order(9001, HOUR);
    const delivered = order(9002, HOUR);
    const channels = [store('ch_1'), store('ch_2')];
    const { scheduler, sync, checkouts, stored } = build(channels, { ch_1: [[lost]], ch_2: [[delivered]] });
    // ch_2's order arrived by webhook.
    stored.set('9002', new Date(delivered.updated_at));

    await scheduler.tick();
    // An hour on, the next run's overlap reads both orders again.
    for (const c of channels) c.orderCatchUpAt = new Date(c.orderCatchUpAt!.getTime() - HOUR);
    await scheduler.tick();

    expect(sync.upsertOrder).toHaveBeenCalledTimes(1);
    expect(sync.upsertOrder.mock.calls[0][2]).toBe(lost);
    // Completing a checkout is harmless to repeat, as on every orders webhook.
    expect(checkouts.markCompleted).toHaveBeenCalledTimes(4);
  });

  it('reads from two hours before the last catch-up, and moves the catch-up time to when this run started', async () => {
    const last = new Date(Date.now() - 2 * HOUR);
    const channel = store('ch_1', { orderCatchUpAt: last });
    const { scheduler, sync } = build([channel], {});
    const before = Date.now();

    await scheduler.tick();

    expect(sync.ordersUpdatedSince).toHaveBeenCalledWith('ch_1', new Date(last.getTime() - 2 * HOUR));
    expect(channel.orderCatchUpAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('reads the last 24 hours on a first run, but nothing from before the store was connected', async () => {
    const connectedAt = new Date(Date.now() - 3 * HOUR);
    const { scheduler, sync } = build([store('ch_old', { connectedAt: null }), store('ch_new', { connectedAt })], {});
    const before = Date.now();

    await scheduler.tick();

    const since = (id: string) => sync.ordersUpdatedSince.mock.calls.find((c) => c[0] === id)![1] as Date;
    expect(Math.abs(since('ch_old').getTime() - (before - 24 * HOUR))).toBeLessThan(1000);
    expect(since('ch_new')).toEqual(connectedAt);
  });

  it('keeps going when one store fails, and reads the failed one again next time', async () => {
    const failing = store('ch_1');
    const healthy = store('ch_2');
    const { scheduler, sync, redis } = build([failing, healthy], {
      ch_1: new Error('Shopify HTTP 404'),
      ch_2: [[order(9002, HOUR)]],
    });

    await scheduler.tick();

    expect(sync.upsertOrder).toHaveBeenCalledWith('ch_2', 'org_1', expect.objectContaining({ id: 9002 }), { live: true });
    expect(failing.orderCatchUpAt).toBeNull();
    expect(healthy.orderCatchUpAt).toBeInstanceOf(Date);
    expect(redis.del).toHaveBeenCalledWith('shopify:order-catch-up:ch_1');
    expect(redis.del).toHaveBeenCalledWith('shopify:order-catch-up:ch_2');
  });

  it('stops a store on a brief database failure, but skips an order that cannot be handled', async () => {
    const outage = store('ch_1');
    const bad = store('ch_2');
    const { scheduler, sync } = build([outage, bad], {
      ch_1: [[order(9001, HOUR), order(9003, HOUR)]],
      ch_2: [[order(9002, HOUR), order(9004, HOUR)]],
    });
    sync.upsertOrder.mockImplementation(async (_c: string, _o: string, so: any) => {
      if (so.id === 9001) throw new PrismaClientKnownRequestError('pool timeout', { code: 'P2024', clientVersion: 'test' });
      if (so.id === 9002) throw new TypeError('bad payload');
    });

    await scheduler.tick();

    const written = sync.upsertOrder.mock.calls.map((c) => c[2].id);
    expect(written).toEqual([9001, 9002, 9004]);
    expect(outage.orderCatchUpAt).toBeNull();
    expect(bad.orderCatchUpAt).toBeInstanceOf(Date);
  });

  it('runs a store again only once its interval has passed, including when another server just ran it', async () => {
    const recent = store('ch_1', { orderCatchUpAt: new Date(Date.now() - 10 * 60 * 1000) });
    const racing = store('ch_2', { orderCatchUpAt: new Date(Date.now() - 2 * HOUR) });
    const { scheduler, prisma, sync } = build([recent, racing], {});
    // ch_2 is due when listed, but another server finishes it before this one takes the lock.
    const list = prisma.channel.findMany.getMockImplementation()!;
    prisma.channel.findMany.mockImplementationOnce(async (args: any) => {
      const rows = await list(args);
      racing.orderCatchUpAt = new Date();
      return rows;
    });

    await scheduler.tick();

    expect(sync.ordersUpdatedSince).not.toHaveBeenCalled();
  });

  it('leaves a store another server is catching up', async () => {
    const { scheduler, sync, redis } = build([store('ch_1')], { ch_1: [[order(9001, HOUR)]] });
    redis.acquireLock.mockResolvedValue(false);

    await scheduler.tick();

    expect(sync.ordersUpdatedSince).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('does not start while its previous run is still going', async () => {
    const { scheduler, prisma } = build([store('ch_1')], {});

    await Promise.all([scheduler.tick(), scheduler.tick()]);

    expect(prisma.channel.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('ShopifySyncService.ordersUpdatedSince', () => {
  const money = (amount: string) => ({ shopMoney: { amount, currencyCode: 'INR' } });
  const node = (n: number) => ({
    id: `gid://shopify/Order/${n}`, name: `#${n}`, number: n, email: null, phone: null, note: null, tags: [],
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED', cancelReason: null, cancelledAt: null,
    closedAt: null, sourceIdentifier: null, sourceName: 'web', app: null, paymentGatewayNames: ['Cash on Delivery (COD)'],
    createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:05:00Z', currencyCode: 'INR',
    currentSubtotalPriceSet: money('100'), totalPriceSet: money('100'), totalTaxSet: money('0'),
    totalDiscountsSet: money('0'), totalShippingPriceSet: money('0'), shippingAddress: null, billingAddress: null,
    customer: null, lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, fulfillments: [],
    totalRefundedSet: money('0'),
  });

  it("gives orders in the webhook's shape, with the checkout they came from and how they were paid", async () => {
    const graphql = {
      request: jest.fn(async (_auth: unknown, query: string, _variables?: unknown, _apiVersion?: string) =>
        query.includes('OrderCheckoutTokens')
          ? { nodes: [{ id: 'gid://shopify/Order/9001', checkoutToken: 'ctok_9001' }, null] }
          : { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(9001), node(9002)] } },
      ),
    };
    const oauth = { getAccessToken: jest.fn().mockResolvedValue({ token: 't', shopDomain: 'shop.myshopify.com' }) };
    // prisma, shopifyOAuth, loyalty, graphql, pushEnqueuer, inventoryLedger,
    // locationSync, config, invoiceService, orgSettings, fx, draftMirrorQueue, commerceEvents
    const service = new ShopifySyncService(
      {} as any, oauth as any, {} as any, graphql as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );

    const pages: Array<Array<Record<string, any>>> = [];
    for await (const page of service.ordersUpdatedSince('ch_1', new Date('2026-10-25T08:00:00Z'))) pages.push(page);

    expect(graphql.request.mock.calls[0][2]).toMatchObject({ query: "updated_at:>='2026-10-25T08:00:00.000Z'" });
    // Order.checkoutToken exists from Admin API 2026-10 only.
    const tokenCall = graphql.request.mock.calls.find((c) => String(c[1]).includes('OrderCheckoutTokens'))!;
    expect(tokenCall[2]).toEqual({ ids: ['gid://shopify/Order/9001', 'gid://shopify/Order/9002'] });
    expect(tokenCall[3]).toBe('2026-10');
    expect(pages).toHaveLength(1);
    expect(pages[0][0]).toMatchObject({
      id: '9001', checkout_token: 'ctok_9001', payment_gateway_names: ['Cash on Delivery (COD)'],
      created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:05:00Z',
    });
    expect(pages[0][1]).toMatchObject({ id: '9002', checkout_token: null });
  });
});
