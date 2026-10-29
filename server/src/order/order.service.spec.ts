import { ServiceUnavailableException } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { OrderService } from './order.service';
import { STALE_PENDING_SYNC_MS } from '../channel/shopify-push.service';

/**
 * The manual "Sync to Shopify" claim. What matters here is the PENDING
 * state machine: a claim must never dead-end an order (nothing queued, yet
 * "already in progress" for ever) and must never let two live pushes create
 * two Shopify orders.
 */

const ORG = 'org_1';
const ORDER_ID = 'cmtij041d0009w54k6tey3ib5';

function manualOrder(metadata: Record<string, unknown> | null) {
  return {
    id: ORDER_ID,
    organizationId: ORG,
    name: '#M1001',
    metadata,
    channel: { id: 'ch_manual', platform: ChannelPlatform.MANUAL as ChannelPlatform },
  };
}

function build(order: ReturnType<typeof manualOrder>, opts: { enqueued?: boolean } = {}) {
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(order) },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
    // mergeJsonMetadata → 1 row = claim won.
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const enqueuer = { enqueueOrderPush: jest.fn().mockResolvedValue(opts.enqueued ?? true) };
  const pushService = {
    findShopifyChannel: jest
      .fn()
      .mockResolvedValue({ id: 'ch_shopify', status: ChannelStatus.CONNECTED }),
    recordFailure: jest.fn().mockResolvedValue(undefined),
  };
  const service = new OrderService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    enqueuer as any,
    pushService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    // ledger, shopifyPushQueue
    { isWarehousingEnabled: jest.fn().mockResolvedValue(false) } as any,
    { getRate: jest.fn().mockResolvedValue(1) } as any,
    { add: jest.fn().mockResolvedValue(undefined) } as any, { order: jest.fn() } as any /* commerceEvents */,
  );
  return { service, prisma, enqueuer, pushService };
}

describe('OrderService.syncToShopify', () => {
  it('claims, dates the claim, logs one timeline entry and enqueues a never-synced order', async () => {
    const { service, prisma, enqueuer } = build(manualOrder({ source: 'offline' }));

    const result = await service.syncToShopify(ORDER_ID, ORG, 'user_1');

    expect(result).toEqual({ status: 'QUEUED', orderId: ORDER_ID });
    expect(enqueuer.enqueueOrderPush).toHaveBeenCalledWith({
      type: 'order',
      orderId: ORDER_ID,
      organizationId: ORG,
    });
    expect(prisma.orderTimelineEvent.create).toHaveBeenCalledTimes(1);

    const values = prisma.$executeRaw.mock.calls[0].slice(1) as unknown[];
    const patch = JSON.parse(values.find((v) => typeof v === 'string' && v.startsWith('{')) as string);
    expect(patch.shopifySync).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(Number.isFinite(Date.parse(patch.shopifySync.queuedAt))).toBe(true);
  });

  // The push books a PAID Shopify order with a full SALE and decrements stock;
  // for a cancelled sale its echo would also revive the order in the CRM.
  it('refuses a cancelled sale with a plain reason, before claiming anything', async () => {
    const { service, enqueuer, prisma } = build({
      ...manualOrder(null),
      cancelledAt: new Date(),
      financialStatus: 'PAID',
    } as any);

    await expect(service.syncToShopify(ORDER_ID, ORG)).rejects.toThrow(
      'This order was cancelled, so it is not sent to Shopify.',
    );
    expect(enqueuer.enqueueOrderPush).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses to re-queue while a recent claim is still in flight', async () => {
    const { service, enqueuer, prisma } = build(
      manualOrder({
        shopifySync: { status: 'PENDING', attempts: 0, queuedAt: new Date().toISOString() },
      }),
    );
    const result = await service.syncToShopify(ORDER_ID, ORG);
    expect(result).toEqual({ status: 'ALREADY_QUEUED', orderId: ORDER_ID });
    expect(enqueuer.enqueueOrderPush).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('re-claims a PENDING order whose job was lost (claim older than the stale window)', async () => {
    const queuedAt = new Date(Date.now() - STALE_PENDING_SYNC_MS - 1000).toISOString();
    const { service, enqueuer } = build(
      manualOrder({ shopifySync: { status: 'PENDING', attempts: 0, queuedAt } }),
    );
    const result = await service.syncToShopify(ORDER_ID, ORG);
    expect(result).toEqual({ status: 'QUEUED', orderId: ORDER_ID });
    expect(enqueuer.enqueueOrderPush).toHaveBeenCalledTimes(1);
  });

  it('re-claims a PENDING order stamped before queuedAt existed', async () => {
    const { service, enqueuer } = build(
      manualOrder({ shopifySync: { status: 'PENDING', attempts: 0 } }),
    );
    await service.syncToShopify(ORDER_ID, ORG);
    expect(enqueuer.enqueueOrderPush).toHaveBeenCalledTimes(1);
  });

  it('marks the order FAILED (not PENDING) and reports when the queue is unavailable', async () => {
    const { service, pushService } = build(manualOrder(null), { enqueued: false });

    await expect(service.syncToShopify(ORDER_ID, ORG)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(pushService.recordFailure).toHaveBeenCalledWith(
      ORDER_ID,
      ORG,
      expect.stringMatching(/queue unavailable/i),
      false,
    );
  });

  it('returns ALREADY_SYNCED without touching the queue', async () => {
    const { service, enqueuer, prisma } = build(
      manualOrder({ shopifySync: { status: 'SYNCED', shopifyOrderId: '1', attempts: 1 } }),
    );
    expect(await service.syncToShopify(ORDER_ID, ORG)).toEqual({
      status: 'ALREADY_SYNCED',
      orderId: ORDER_ID,
    });
    expect(enqueuer.enqueueOrderPush).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('reports ALREADY_SYNCED when a worker finishes between the read and the claim', async () => {
    const { service, prisma, enqueuer } = build(manualOrder(null));
    prisma.$executeRaw.mockResolvedValueOnce(0); // guard refused: row is SYNCED now
    expect(await service.syncToShopify(ORDER_ID, ORG)).toEqual({
      status: 'ALREADY_SYNCED',
      orderId: ORDER_ID,
    });
    expect(enqueuer.enqueueOrderPush).not.toHaveBeenCalled();
  });

  it('rejects orders that originated in Shopify', async () => {
    const { service } = build({
      ...manualOrder(null),
      channel: { id: 'ch_shopify', platform: ChannelPlatform.SHOPIFY },
    });
    await expect(service.syncToShopify(ORDER_ID, ORG)).rejects.toThrow(/originated in Shopify/);
  });
});

/**
 * Releasing a hold. The line has to come back to whatever its shipped units
 * say it is — and a line already marked delivered must not be quietly demoted,
 * which is what passing a hard-coded `previous` did.
 */
describe('OrderService.setVendorItemsStatus (released)', () => {
  const ORDER = 'order_1';

  function buildForRelease(lines: Array<Record<string, unknown>>) {
    const updated: Array<{ where: any; data: any }> = [];
    const tx = {
      orderLineItem: {
        findMany: jest.fn().mockResolvedValue(lines),
        update: jest.fn((args: any) => {
          updated.push(args);
          return Promise.resolve({});
        }),
        updateMany: jest.fn().mockResolvedValue({ count: lines.length }),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ lineItems: lines }), update: jest.fn() },
      orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
      // The order-row lock taken before any line is written.
      $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER, cancelledAt: null }]),
    };
    const prisma = {
      order: {
        findFirst: jest.fn().mockResolvedValue({
          id: ORDER,
          organizationId: ORG,
          // MANUAL so the best-effort Shopify status push is skipped — this
          // test is about the local status the release computes.
          channel: { id: 'ch_manual', platform: ChannelPlatform.MANUAL },
        }),
      },
      orderLineItem: { findMany: jest.fn().mockResolvedValue(lines) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new OrderService(
      prisma as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
      { isWarehousingEnabled: jest.fn().mockResolvedValue(false) } as any,
      { getRate: jest.fn().mockResolvedValue(1) } as any,
      { add: jest.fn().mockResolvedValue(undefined) } as any, { order: jest.fn() } as any /* commerceEvents */,
    );
    return { service, tx, updated };
  }

  it('keeps a delivered line delivered', async () => {
    const { service, updated } = buildForRelease([
      { id: 'li_1', quantity: 3, fulfilledQuantity: 3, fulfillmentStatus: 'delivered' },
    ]);

    await service.setVendorItemsStatus(ORDER, ORG, 'user_1', 'released', ['li_1']);

    expect(updated).toHaveLength(1);
    expect(updated[0].data.fulfillmentStatus).toBe('delivered');
  });

  it('returns a half-shipped line to partial, not unfulfilled', async () => {
    const { service, updated } = buildForRelease([
      { id: 'li_1', quantity: 5, fulfilledQuantity: 2, fulfillmentStatus: 'on_hold' },
    ]);

    await service.setVendorItemsStatus(ORDER, ORG, 'user_1', 'released', ['li_1']);

    expect(updated[0].data.fulfillmentStatus).toBe('partial');
  });

  it('returns a line with nothing shipped to unfulfilled', async () => {
    const { service, updated } = buildForRelease([
      { id: 'li_1', quantity: 5, fulfilledQuantity: 0, fulfillmentStatus: 'on_hold' },
    ]);

    await service.setVendorItemsStatus(ORDER, ORG, 'user_1', 'released', ['li_1']);

    expect(updated[0].data.fulfillmentStatus).toBeNull();
  });
});

describe('OrderService.computeFulfillmentStatus', () => {
  // The one rule every header is derived from; it had no direct test.
  const compute = (items: any[]) =>
    (new OrderService(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { order: jest.fn() } as any /* commerceEvents */,
    ) as any).computeFulfillmentStatus(items);

  it('is UNFULFILLED when no unit has shipped', () => {
    expect(compute([{ fulfillmentStatus: null, quantity: 2, fulfilledQuantity: 0 }])).toBe('UNFULFILLED');
  });

  it('is FULFILLED when every unit has shipped', () => {
    expect(
      compute([
        { fulfillmentStatus: 'fulfilled', quantity: 2, fulfilledQuantity: 2 },
        { fulfillmentStatus: 'delivered', quantity: 1, fulfilledQuantity: 1 },
      ]),
    ).toBe('FULFILLED');
  });

  it('is PARTIAL when some but not all units have shipped', () => {
    expect(
      compute([
        { fulfillmentStatus: 'partial', quantity: 3, fulfilledQuantity: 1 },
        { fulfillmentStatus: null, quantity: 1, fulfilledQuantity: 0 },
      ]),
    ).toBe('PARTIAL');
  });

  it('counts a zero-count line whose status says shipped as fully shipped (Shopify lines)', () => {
    expect(compute([{ fulfillmentStatus: 'fulfilled', quantity: 4, fulfilledQuantity: 0 }])).toBe('FULFILLED');
  });

  it('never counts more than the line ordered', () => {
    expect(compute([{ fulfillmentStatus: 'fulfilled', quantity: 2, fulfilledQuantity: 5 }])).toBe('FULFILLED');
  });
});

/**
 * The order's invoice card. Credit notes are stored with the ORIGINAL
 * invoice's orderId and are created after it, so a filter that only dropped
 * CANCELLED returned the newest credit note as "the invoice" (#M1001 showed
 * CN-26-27/000001 instead of INV-26-27/000001 on dev).
 */
describe('OrderService.findOne invoice', () => {
  /** Applies a Prisma `status` filter the way the database would. */
  const allows = (status: string, filter: any) =>
    filter?.notIn ? !filter.notIn.includes(status) : filter?.not ? status !== filter.not : true;

  function build(invoices: Array<{ id: string; status: string; createdAt: Date }>) {
    const prisma = {
      order: {
        findFirst: jest.fn((args: any) => {
          const rel = args.include.invoices;
          const live = invoices
            .filter((i) => allows(i.status, rel.where.status))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, rel.take);
          return Promise.resolve({ id: ORDER_ID, lineItems: [], fulfillments: [], invoices: live });
        }),
      },
    };
    const service = new OrderService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { order: jest.fn() } as any /* commerceEvents */,
    );
    return service;
  }

  it('shows the original invoice, not a later credit note against it', async () => {
    const service = build([
      { id: 'inv_1', status: 'ISSUED', createdAt: new Date('2026-09-01T00:00:00Z') },
      { id: 'cn_1', status: 'CREDIT_NOTE', createdAt: new Date('2026-09-10T00:00:00Z') },
    ]);

    const order = await service.findOne(ORDER_ID, ORG);

    expect(order.invoices.map((i: any) => i.id)).toEqual(['inv_1']);
  });

  it('shows no invoice once the original is cancelled, even with a credit note left', async () => {
    const service = build([
      { id: 'inv_1', status: 'CANCELLED', createdAt: new Date('2026-09-01T00:00:00Z') },
      { id: 'cn_1', status: 'CREDIT_NOTE', createdAt: new Date('2026-09-10T00:00:00Z') },
    ]);

    const order = await service.findOne(ORDER_ID, ORG);

    expect(order.invoices).toEqual([]);
  });
});

describe('OrderService.findAll date range', () => {
  function build() {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }) },
    };
    const service = new OrderService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { order: jest.fn() } as any /* commerceEvents */,
    );
    return { service, prisma };
  }

  it('windows on placedBetween, the same rule as the exports', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { dateFrom: '2026-10-01', dateTo: '2026-10-12' } as any);

    const { where } = prisma.order.findMany.mock.calls[0][0];
    // A bare `externalCreatedAt` range never matches NULL. No write path leaves
    // it NULL today, but the list and its downloads must share one definition
    // of "placed", or a null-dated order would land in one and not the other.
    expect(where.externalCreatedAt).toBeUndefined();
    const range = { gte: expect.any(Date), lt: expect.any(Date) };
    expect(where.AND).toEqual([
      {
        OR: [
          { externalCreatedAt: range },
          { externalCreatedAt: null, createdAt: range },
        ],
      },
    ]);
    // Bare dates are whole days in the reporting zone (UTC default → IST).
    const [{ OR: [{ externalCreatedAt: bounds }] }] = where.AND;
    expect(bounds.gte.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(bounds.lt.toISOString()).toBe('2026-10-12T18:30:00.000Z');
    expect(prisma.order.count).toHaveBeenCalledWith({ where });
  });

  it('does not let the date window overwrite the search OR', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { dateFrom: '2026-10-01', search: 'shirt' } as any);

    const { where } = prisma.order.findMany.mock.calls[0][0];
    expect(where.OR).toEqual(
      expect.arrayContaining([{ name: { contains: 'shirt', mode: 'insensitive' } }]),
    );
    expect(where.AND).toHaveLength(1);
  });

  it('searches every date when no range is sent', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { search: '#4706' } as any);

    const { where } = prisma.order.findMany.mock.calls[0][0];
    expect(where.AND).toBeUndefined();
    expect(where.OR).toEqual(
      expect.arrayContaining([{ name: { contains: '#4706', mode: 'insensitive' } }]),
    );
  });
});

describe('OrderService.findAll phone search', () => {
  function build(phoneMatches: string[] = ['ord_1', 'ord_2']) {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $queryRaw: jest.fn().mockResolvedValue(phoneMatches.map((id) => ({ id }))),
      organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }) },
    };
    const service = new OrderService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { order: jest.fn() } as any /* commerceEvents */,
    );
    return { service, prisma };
  }

  const sqlOf = (call: any[]) => (call[0] as string[]).join('?');

  it('finds the orders of a buyer typed with spaces, by digits only', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { search: '98765 43210' } as any);

    const call = prisma.$queryRaw.mock.calls[0];
    expect(sqlOf(call)).toContain(`regexp_replace(coalesce(c."phone", ''), '\\D', '', 'g') LIKE`);
    expect(sqlOf(call)).toContain(`o."shipping_address"->>'phone'`);
    expect(call.slice(1)).toContain('%9876543210%');

    const { where } = prisma.order.findMany.mock.calls[0][0];
    expect(where.OR).toEqual(expect.arrayContaining([{ id: { in: ['ord_1', 'ord_2'] } }]));
    // Still matches names and emails as before.
    expect(where.OR).toEqual(
      expect.arrayContaining([{ name: { contains: '98765 43210', mode: 'insensitive' } }]),
    );
  });

  it('matches the last ten digits, so a number with its country code finds one saved without', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { search: '+91 98765-43210' } as any);

    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain('%9876543210%');
  });

  it('leaves order numbers and names to the plain search', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { search: '4706' } as any);
    await service.findAll(ORG, { search: 'Meera 98765' } as any);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('adds nothing to the search when no buyer has the number', async () => {
    const { service, prisma } = build([]);
    await service.findAll(ORG, { search: '9876543210' } as any);

    const { where } = prisma.order.findMany.mock.calls[0][0];
    expect(where.OR.some((c: any) => 'id' in c)).toBe(false);
  });
});

describe('OrderService.findAll payment filter', () => {
  const UNPAID = ['PENDING', 'AUTHORIZED', 'PARTIALLY_PAID'];

  function build(gateways: string[] = ['Cash on Delivery (COD)', 'Razorpay', 'cod']) {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $queryRaw: jest.fn().mockResolvedValue(gateways.map((name) => ({ name }))),
      organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }) },
    };
    const service = new OrderService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { order: jest.fn() } as any /* commerceEvents */,
    );
    return { service, prisma };
  }

  const whereOf = (prisma: ReturnType<typeof build>['prisma']) =>
    prisma.order.findMany.mock.calls[0][0].where;

  it('COD is unpaid cash on delivery, by the gateway names this org uses', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { payment: 'cod' } as any);

    expect(whereOf(prisma).AND).toEqual([
      {
        financialStatus: { in: UNPAID },
        paymentGateways: { hasSome: ['Cash on Delivery (COD)', 'cod'] },
      },
    ]);
  });

  it('pending is an unpaid order that is not cash on delivery', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { payment: 'pending' } as any);

    expect(whereOf(prisma).AND).toEqual([
      {
        financialStatus: { in: UNPAID },
        NOT: { paymentGateways: { hasSome: ['Cash on Delivery (COD)', 'cod'] } },
      },
    ]);
  });

  it('matches no order for COD when no order was ever cash on delivery', async () => {
    const { service, prisma } = build(['Razorpay']);
    await service.findAll(ORG, { payment: 'cod' } as any);

    expect(whereOf(prisma).AND).toEqual([{ id: { in: [] } }]);
  });

  it('paid and refunded are plain statuses, with partly refunded counted as refunded', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { payment: 'paid' } as any);
    await service.findAll(ORG, { payment: 'refunded' } as any);

    expect(prisma.order.findMany.mock.calls[0][0].where.AND).toEqual([{ financialStatus: 'PAID' }]);
    expect(prisma.order.findMany.mock.calls[1][0].where.AND).toEqual([
      { financialStatus: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } },
    ]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('keeps the date window beside the payment filter', async () => {
    const { service, prisma } = build();
    await service.findAll(ORG, { payment: 'paid', dateFrom: '2026-10-01' } as any);

    expect(whereOf(prisma).AND).toHaveLength(2);
  });

  it('marks each row as cash on delivery or not', async () => {
    const { service, prisma } = build();
    const row = (id: string, paymentGateways: string[]) => ({
      id, paymentGateways, metadata: null, customer: null, channel: null, _count: { lineItems: 1 },
    });
    prisma.order.findMany.mockResolvedValue([
      row('a', ['Cash on Delivery (COD)']),
      row('b', ['Razorpay']),
    ]);

    const { data } = await service.findAll(ORG, {} as any);

    expect(data.map((o: any) => o.cashOnDelivery)).toEqual([true, false]);
  });
});
