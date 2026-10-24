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
  const commerceEvents = { order: jest.fn().mockResolvedValue(undefined) };
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
  jest.spyOn(s, 'writeOrderChildren').mockResolvedValue({ newlyDelivered: false });
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
    s.writeOrderChildren.mockResolvedValue({ newlyDelivered: true });

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
    await expect(result).resolves.toEqual({ newlyDelivered: true });
    expect(tx.orderFulfillment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', externalId: '77', deliveredAt: null },
      data: { deliveredAt: expect.any(Date) },
    });
  });

  // A tag or note on an order delivered last week re-sends the same payload.
  it('does not report a delivery already on record', async () => {
    const { result } = run({ recorded: 0, fulfilmentCreatedAt: new Date(Date.now() - 3 * 24 * HOUR) });
    await expect(result).resolves.toEqual({ newlyDelivered: false });
  });

  it('records but does not announce the delivery of a long-past shipment', async () => {
    const { result } = run({ recorded: 1, fulfilmentCreatedAt: new Date(Date.now() - 90 * 24 * HOUR) });
    await expect(result).resolves.toEqual({ newlyDelivered: false });
  });
});
