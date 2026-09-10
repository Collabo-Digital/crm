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
    { add: jest.fn().mockResolvedValue(undefined) } as any,
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
      { add: jest.fn().mockResolvedValue(undefined) } as any,
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
