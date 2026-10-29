import { ShopifySyncService } from './shopify-sync.service';

/**
 * Store events (order messages, COD confirmation, review requests) and
 * auto-invoicing follow what really just happened to an order, not what a
 * webhook happens to show. Any edit to an old order sends `orders/updated`;
 * before these guards that read as a brand-new order, or as a fresh delivery.
 */

const ORG = 'org_1';
const CHANNEL = 'ch_shopify';
const HOUR = 60 * 60 * 1000;
const NO_NEWS = { newlyDelivered: false, newlyOutForDelivery: false, refunds: [] };

function build() {
  const tx = {
    order: { upsert: jest.fn().mockResolvedValue({ id: 'o1' }) },
    orderTimelineEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    channel: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const commerceEvents = { order: jest.fn().mockResolvedValue(undefined), refunded: jest.fn().mockResolvedValue(undefined) };
  const invoiceService = { autoInvoiceForShippedCodOrder: jest.fn().mockResolvedValue(undefined) };
  const fx = { ratePatch: jest.fn().mockResolvedValue({}) };
  // prisma, shopifyOAuth, loyalty, graphql, pushEnqueuer, inventoryLedger,
  // locationSync, config, invoiceService, orgSettings, fx, draftMirrorQueue, commerceEvents
  const service = new ShopifySyncService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, invoiceService as any, {} as any, fx as any, {} as any,
    commerceEvents as any,
  );
  const s = service as any;
  jest.spyOn(s, 'crmOriginOf').mockResolvedValue({ crmOrigin: false, customer: null });
  jest.spyOn(s, 'gstContext').mockResolvedValue({ enabled: false });
  jest.spyOn(s, 'writeOrderChildren').mockResolvedValue(NO_NEWS);
  const maybeAutoInvoice = jest.spyOn(s, 'maybeAutoInvoice').mockResolvedValue(undefined);
  jest.spyOn(s, 'ensureDispatchWarehouseFromShopify').mockResolvedValue(undefined);
  jest.spyOn(s.logger, 'log').mockImplementation(() => undefined);
  return { service, s, tx, commerceEvents, maybeAutoInvoice };
}

function paidFulfilledOrder(createdAt: Date) {
  return {
    id: 5550001,
    order_number: 1042,
    name: '#1042',
    financial_status: 'paid',
    fulfillment_status: 'fulfilled',
    created_at: createdAt.toISOString(),
    updated_at: new Date().toISOString(),
    line_items: [],
    fulfillments: [],
  };
}

describe('ShopifySyncService.upsertOrder — first sighting on a live webhook', () => {
  it('imports a months-old order silently: no order messages, no invoice dated today', async () => {
    const { service, tx, commerceEvents, maybeAutoInvoice } = build();

    await service.upsertOrder(CHANNEL, ORG, paidFulfilledOrder(new Date(Date.now() - 180 * 24 * HOUR)), {
      live: true,
    });

    expect(tx.order.upsert).toHaveBeenCalledTimes(1);
    // The timeline still records when it was placed.
    expect(tx.orderTimelineEvent.create).toHaveBeenCalledTimes(1);
    expect(commerceEvents.order).not.toHaveBeenCalled();
    expect(maybeAutoInvoice).not.toHaveBeenCalled();
  });

  it('treats an order placed an hour ago as new', async () => {
    const { service, commerceEvents, maybeAutoInvoice } = build();

    await service.upsertOrder(CHANNEL, ORG, paidFulfilledOrder(new Date(Date.now() - HOUR)), {
      live: true,
    });

    expect(commerceEvents.order).toHaveBeenCalledWith('o1', ['created', 'paid', 'fulfilled']);
    expect(maybeAutoInvoice).toHaveBeenCalledWith(ORG, 'o1');
  });

  it("raises 'delivered' only when the write recorded a new delivery", async () => {
    const { service, s, commerceEvents } = build();
    s.writeOrderChildren.mockResolvedValue({ ...NO_NEWS, newlyDelivered: true });

    await service.upsertOrder(CHANNEL, ORG, paidFulfilledOrder(new Date(Date.now() - HOUR)), {
      live: true,
    });

    expect(commerceEvents.order.mock.calls[0][1]).toContain('delivered');
  });
});

describe('ShopifySyncService.writeOrderChildren — carrier delivery', () => {
  function run(opts: { recorded: number; fulfilmentCreatedAt: Date }) {
    const { s } = build();
    s.writeOrderChildren.mockRestore();
    const tx = {
      orderFulfillment: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: opts.recorded }),
      },
    };
    const so = {
      id: 1,
      fulfillments: [
        {
          id: 77,
          status: 'success',
          shipment_status: 'delivered',
          created_at: opts.fulfilmentCreatedAt.toISOString(),
        },
      ],
    };
    const maps = { variantByExternalId: new Map(), productByExternalId: new Map() };
    return { tx, result: s.writeOrderChildren(tx, 'o1', so, [], maps) };
  }

  it('records the delivery once and reports it as new', async () => {
    const { tx, result } = run({ recorded: 1, fulfilmentCreatedAt: new Date(Date.now() - 3 * 24 * HOUR) });
    await expect(result).resolves.toEqual({ ...NO_NEWS, newlyDelivered: true });
    expect(tx.orderFulfillment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', externalId: '77', deliveredAt: null },
      data: { deliveredAt: expect.any(Date) },
    });
  });

  // A tag or note on an order delivered last week re-sends the same payload.
  it('does not report a delivery already on record', async () => {
    const { result } = run({ recorded: 0, fulfilmentCreatedAt: new Date(Date.now() - 3 * 24 * HOUR) });
    await expect(result).resolves.toEqual(NO_NEWS);
  });

  it('records but does not announce the delivery of a long-past shipment', async () => {
    const { result } = run({ recorded: 1, fulfilmentCreatedAt: new Date(Date.now() - 90 * 24 * HOUR) });
    await expect(result).resolves.toEqual(NO_NEWS);
  });
});

describe('ShopifySyncService.writeOrderChildren — out for delivery', () => {
  function run(opts: { statuses: string[]; recorded?: number; deliveredBefore?: number; createdAt?: Date }) {
    const { s } = build();
    s.writeOrderChildren.mockRestore();
    const tx = {
      orderFulfillment: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: opts.recorded ?? 1 }),
        count: jest.fn().mockResolvedValue(opts.deliveredBefore ?? 0),
      },
    };
    const so = {
      id: 1,
      fulfillments: opts.statuses.map((shipment_status, i) => ({
        id: 77 + i,
        status: 'success',
        shipment_status,
        created_at: (opts.createdAt ?? new Date(Date.now() - 2 * 24 * HOUR)).toISOString(),
      })),
    };
    const maps = { variantByExternalId: new Map(), productByExternalId: new Map() };
    return { tx, result: s.writeOrderChildren(tx, 'o1', so, [], maps) };
  }

  it('records it once, guarded like a delivery, and reports it as news', async () => {
    const { tx, result } = run({ statuses: ['out_for_delivery'] });
    await expect(result).resolves.toEqual({ ...NO_NEWS, newlyOutForDelivery: true });
    expect(tx.orderFulfillment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', externalId: '77', outForDeliveryAt: null, deliveredAt: null },
      data: { outForDeliveryAt: expect.any(Date) },
    });
  });

  it('is not news again, nor once any shipment of the order was delivered', async () => {
    await expect(run({ statuses: ['out_for_delivery'], recorded: 0 }).result).resolves.toEqual(NO_NEWS);
    await expect(run({ statuses: ['out_for_delivery'], deliveredBefore: 1 }).result).resolves.toEqual(NO_NEWS);
  });

  it('gives way to a delivery reported in the same update', async () => {
    await expect(run({ statuses: ['delivered', 'out_for_delivery'] }).result).resolves.toEqual({ ...NO_NEWS, newlyDelivered: true });
  });

  it('is not announced for a long-past shipment', async () => {
    await expect(run({ statuses: ['out_for_delivery'], createdAt: new Date(Date.now() - 90 * 24 * HOUR) }).result).resolves.toEqual(NO_NEWS);
  });
});

describe('ShopifySyncService.writeOrderChildren — refunds', () => {
  function run(refunds: unknown[]) {
    const { s } = build();
    s.writeOrderChildren.mockRestore();
    let n = 0;
    const tx = { orderRefund: { upsert: jest.fn(async () => ({ id: `rf_${++n}`, currency: 'INR' })) } };
    const maps = { variantByExternalId: new Map(), productByExternalId: new Map() };
    return s.writeOrderChildren(tx, 'o1', { id: 1, currency: 'INR', refunds }, [], maps);
  }
  const refund = (id: number, amount: string, processedAt: Date) => ({
    id,
    processed_at: processedAt.toISOString(),
    created_at: processedAt.toISOString(),
    transactions: [{ kind: 'refund', status: 'success', amount }],
  });

  it('reports each recent refund that returned money, by its row', async () => {
    const news = await run([refund(901, '500.00', new Date(Date.now() - HOUR))]);
    expect(news.refunds).toEqual([{ id: 'rf_1', amount: '500', currency: 'INR' }]);
  });

  it('leaves out a restock-only refund (no money moved) and an old one', async () => {
    const news = await run([refund(902, '0.00', new Date(Date.now() - HOUR)), refund(903, '250.00', new Date(Date.now() - 3 * 24 * HOUR))]);
    expect(news.refunds).toEqual([]);
  });
});

describe('ShopifySyncService.upsertOrder — new store events', () => {
  it("raises 'out_for_delivery' from the write's news", async () => {
    const { service, s, commerceEvents } = build();
    s.writeOrderChildren.mockResolvedValue({ ...NO_NEWS, newlyOutForDelivery: true });
    await service.upsertOrder(CHANNEL, ORG, paidFulfilledOrder(new Date(Date.now() - HOUR)), { live: true });
    expect(commerceEvents.order.mock.calls[0][1]).toContain('out_for_delivery');
  });

  it('raises one refund event per refund the write found', async () => {
    const { service, s, commerceEvents } = build();
    const refunds = [{ id: 'rf_1', amount: '500', currency: 'INR' }, { id: 'rf_2', amount: '120', currency: 'INR' }];
    s.writeOrderChildren.mockResolvedValue({ ...NO_NEWS, refunds });
    await service.upsertOrder(CHANNEL, ORG, paidFulfilledOrder(new Date(Date.now() - HOUR)), { live: true });
    expect(commerceEvents.refunded.mock.calls).toEqual([['o1', refunds[0]], ['o1', refunds[1]]]);
  });

  it('raises none for an order imported quietly', async () => {
    const { service, s, commerceEvents } = build();
    s.writeOrderChildren.mockResolvedValue({ ...NO_NEWS, newlyOutForDelivery: true, refunds: [{ id: 'rf_1', amount: '500', currency: 'INR' }] });
    await service.upsertOrder(CHANNEL, ORG, paidFulfilledOrder(new Date(Date.now() - 180 * 24 * HOUR)), { live: true });
    expect(commerceEvents.order).not.toHaveBeenCalled();
    expect(commerceEvents.refunded).not.toHaveBeenCalled();
  });
});

describe('ShopifySyncService.upsertRefund — the refund event', () => {
  function build2(alreadyRecorded: boolean) {
    const tx = {
      orderRefund: { upsert: jest.fn().mockResolvedValue({ id: 'rf_row', currency: 'INR' }) },
      orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      order: { findUnique: jest.fn().mockResolvedValue({ id: 'o1', currency: 'INR' }) },
      orderRefund: { findUnique: jest.fn().mockResolvedValue(alreadyRecorded ? { id: 'rf_row' } : null) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const commerceEvents = { order: jest.fn(), refunded: jest.fn().mockResolvedValue(undefined) };
    const service = new ShopifySyncService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      commerceEvents as any,
    );
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    return { service, commerceEvents };
  }
  const body = (amount: string, processedAt = new Date()) => ({
    id: 901, order_id: 5550001, note: null, processed_at: processedAt.toISOString(), created_at: processedAt.toISOString(),
    transactions: [{ kind: 'refund', status: 'success', amount }],
  });

  it('raises it for a refund that returned money, by its row, even when orders/updated stored it first', async () => {
    for (const recorded of [false, true]) {
      const { service, commerceEvents } = build2(recorded);
      await service.upsertRefund(CHANNEL, body('500.00'));
      expect(commerceEvents.refunded).toHaveBeenCalledWith('o1', { id: 'rf_row', amount: '500', currency: 'INR' });
    }
  });

  it('raises nothing for a restock-only refund or an old one', async () => {
    const zero = build2(false);
    await zero.service.upsertRefund(CHANNEL, body('0.00'));
    const old = build2(false);
    await old.service.upsertRefund(CHANNEL, body('500.00', new Date(Date.now() - 2 * 24 * HOUR)));
    expect(zero.commerceEvents.refunded).not.toHaveBeenCalled();
    expect(old.commerceEvents.refunded).not.toHaveBeenCalled();
  });
});
