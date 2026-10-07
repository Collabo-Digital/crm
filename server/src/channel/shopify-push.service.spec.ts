import { ChannelPlatform, ChannelStatus, Prisma } from '@prisma/client';
import {
  ShopifyPushService,
  isStalePendingSync,
  readStoredTaxLines,
  shopifyOrderCustomer,
  shopifyOrderPhone,
  STALE_PENDING_SYNC_MS,
} from './shopify-push.service';
import {
  INVENTORY_ACTIVATE_MUTATION,
  INVENTORY_DEACTIVATE_MUTATION,
  INVENTORY_LEVEL_AT_LOCATION_QUERY,
  INVENTORY_SET_QUANTITIES_MUTATION,
  ORDER_CREATE_MUTATION,
} from './shopify-graphql.types';

/**
 * `pushOrder` is the only code that turns a CRM counter sale into a real
 * Shopify order, and a Shopify order cannot be un-created. These tests pin
 * the payload it sends (verified against collabo-test #1008 on 2026-09-03,
 * which arrived with zero tax because no `taxLines` were sent) and the
 * re-entry guards that stop a retried job from creating a SECOND order.
 */

const ORG = 'org_1';
const ORDER_ID = 'cmtij041d0009w54k6tey3ib5';
const SHOPIFY_CHANNEL = {
  id: 'ch_shopify',
  organizationId: ORG,
  platform: ChannelPlatform.SHOPIFY,
  status: ChannelStatus.CONNECTED,
  metadata: { shopifyLocationId: 84967948340 },
};

function decimal(v: string | number) {
  return new Prisma.Decimal(v);
}

/** A two-line offline order: one mapped Shopify variant, one CRM-only item. */
function offlineOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    organizationId: ORG,
    name: '#M1001',
    currency: 'INR',
    note: null,
    totalPrice: decimal('1769.90'),
    metadata: { source: 'offline', paymentMethod: 'CARD' },
    externalId: 'manual_abc',
    channel: { platform: ChannelPlatform.MANUAL },
    customer: {
      externalId: 'manual_0e7dfaef',
      email: null,
      phone: '9847586793',
    },
    lineItems: [
      {
        id: 'li_1',
        externalId: 'manual_li_1',
        title: 'tEST 2',
        variantTitle: null,
        quantity: 1,
        price: decimal('120'),
        channelTaxLines: [
          { title: 'CGST', rate: 0.09, price: '10.80' },
          { title: 'SGST', rate: 0.09, price: '10.80' },
        ],
        variant: { externalId: '47778382807092' },
      },
      {
        id: 'li_2',
        externalId: 'manual_li_2',
        title: 'Gift wrap',
        variantTitle: 'Large',
        quantity: 2,
        price: decimal('50'),
        channelTaxLines: null,
        variant: { externalId: 'manual_variant_x' },
      },
    ],
    ...overrides,
  };
}

function orderCreateResponse() {
  return {
    orderCreate: {
      order: {
        id: 'gid://shopify/Order/6418037801012',
        name: '#1008',
        lineItems: {
          nodes: [
            { id: 'gid://shopify/LineItem/15162543800372', variant: { id: 'gid://shopify/ProductVariant/47778382807092' } },
            { id: 'gid://shopify/LineItem/15162543833140', variant: null },
          ],
        },
      },
      userErrors: [],
    },
  };
}

function build(order: ReturnType<typeof offlineOrder> | null, channel: unknown = SHOPIFY_CHANNEL) {
  const prisma = {
    channel: { findUnique: jest.fn().mockResolvedValue(channel), update: jest.fn() },
    order: { findFirst: jest.fn().mockResolvedValue(order) },
    orderLineItem: { update: jest.fn((args) => args) },
    // The org's currency is the source side of a catalogue-price conversion —
    // a CRM-native product is priced in it.
    organization: {
      findUnique: jest.fn().mockResolvedValue({ currency: 'INR' }),
    },
    $transaction: jest.fn().mockResolvedValue(undefined),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const shopifyOAuth = {
    getAccessToken: jest.fn().mockResolvedValue({ token: 'tok', shopDomain: 'collabo-test.myshopify.com' }),
  };
  const graphql = {
    request: jest.fn(async (_auth: unknown, query: string, _vars?: unknown): Promise<any> => {
      if (query === ORDER_CREATE_MUTATION) return orderCreateResponse();
      // fulfillment-orders lookup for the best-effort auto-fulfil
      return { order: { fulfillmentOrders: { nodes: [] } } };
    }),
  };
  // Catalogue prices are restated in the destination store's currency on push.
  // A fixed rate keeps the assertions arithmetic rather than network-dependent.
  const fx = { getRate: jest.fn().mockResolvedValue(95) };
  const service = new ShopifyPushService(
    prisma as any,
    shopifyOAuth as any,
    graphql as any,
    {} as any,
    {} as any,
    fx as any,
  );
  return { service, prisma, graphql, shopifyOAuth, fx };
}

/** The metadata patch `writeSyncMeta` sent through mergeJsonMetadata. */
function lastSyncPatch(prisma: { $executeRaw: jest.Mock }) {
  const call = prisma.$executeRaw.mock.calls.at(-1);
  if (!call) return null;
  // Tagged-template call: values are the interpolations, the patch JSON is
  // the first string value.
  const values = call.slice(1) as unknown[];
  const json = values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
  return JSON.parse(json).shopifySync;
}

describe('ShopifyPushService.pushOrder', () => {
  it('sends tax lines, pre-tax prices, source markers and a full-total SALE transaction', async () => {
    const { service, graphql, prisma } = build(offlineOrder());

    await service.pushOrder(ORDER_ID, ORG);

    const createCall = graphql.request.mock.calls.find((c) => c[1] === ORDER_CREATE_MUTATION)!;
    const vars = createCall[2] as any;
    const input = vars.order;

    expect(input.taxesIncluded).toBe(false);
    expect(input.currency).toBe('INR');
    expect(input.sourceName).toBe('collabo-crm');
    expect(input.sourceIdentifier).toBe(ORDER_ID);
    expect(input.tags).toEqual(expect.arrayContaining(['collabo-crm']));
    expect(vars.options.inventoryBehaviour).toBe('DECREMENT_OBEYING_POLICY');

    // Mapped variant → variantId + its stored GST heads.
    expect(input.lineItems[0]).toEqual({
      variantId: 'gid://shopify/ProductVariant/47778382807092',
      quantity: 1,
      priceSet: { shopMoney: { amount: '120', currencyCode: 'INR' } },
      taxLines: [
        { title: 'CGST', rate: 0.09, priceSet: { shopMoney: { amount: '10.80', currencyCode: 'INR' } } },
        { title: 'SGST', rate: 0.09, priceSet: { shopMoney: { amount: '10.80', currencyCode: 'INR' } } },
      ],
    });
    // CRM-only item → custom line, title carries the variant, no taxLines key.
    expect(input.lineItems[1]).toEqual({
      title: 'Gift wrap — Large',
      quantity: 2,
      priceSet: { shopMoney: { amount: '50', currencyCode: 'INR' } },
    });

    // Phone-only walk-in: no customer block (Shopify can't upsert without an
    // email); the phone rides on the order. It was stored as typed and goes
    // out as E.164 — Shopify rejects the whole order for a bare local number.
    expect(input.customer).toBeUndefined();
    expect(input.phone).toBe('+919847586793');
    expect(input.email).toBeUndefined();

    expect(input.transactions).toEqual([
      {
        kind: 'SALE',
        status: 'SUCCESS',
        amountSet: { shopMoney: { amount: '1769.9', currencyCode: 'INR' } },
        gateway: 'manual_card',
      },
    ]);

    // Shopify's line ids adopted so the returning webhook updates in place.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.orderLineItem.update).toHaveBeenCalledWith({
      where: { id: 'li_1' },
      data: { externalId: '15162543800372' },
    });
    expect(prisma.orderLineItem.update).toHaveBeenCalledWith({
      where: { id: 'li_2' },
      data: { externalId: '15162543833140' },
    });

    expect(lastSyncPatch(prisma)).toMatchObject({
      status: 'SYNCED',
      shopifyOrderId: '6418037801012',
      shopifyOrderName: '#1008',
      attempts: 1,
    });
  });

  it('associates a customer that came from Shopify by GID', async () => {
    const { service, graphql } = build(
      offlineOrder({ customer: { externalId: '7011860054246', email: 'a@b.c', phone: null } }),
    );
    await service.pushOrder(ORDER_ID, ORG);
    const input = (graphql.request.mock.calls.find((c) => c[1] === ORDER_CREATE_MUTATION)![2] as any).order;
    expect(input.customer).toEqual({ toAssociate: { id: 'gid://shopify/Customer/7011860054246' } });
    expect(input.email).toBe('a@b.c');
  });

  it('does not push an order already rebadged onto the Shopify channel, but records success', async () => {
    const { service, graphql, prisma } = build(
      offlineOrder({ channel: { platform: ChannelPlatform.SHOPIFY }, externalId: '6418037801012' }),
    );
    await service.pushOrder(ORDER_ID, ORG);
    expect(graphql.request).not.toHaveBeenCalled();
    expect(lastSyncPatch(prisma)).toMatchObject({ status: 'SYNCED', shopifyOrderId: '6418037801012' });
  });

  it('does not push an order whose metadata already records a synced Shopify id', async () => {
    const { service, graphql, prisma } = build(
      offlineOrder({
        metadata: { shopifySync: { status: 'SYNCED', shopifyOrderId: '6418037801012', attempts: 1 } },
      }),
    );
    await service.pushOrder(ORDER_ID, ORG);
    expect(graphql.request).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('records a non-counting failure when no Shopify channel is connected', async () => {
    const { service, graphql, prisma } = build(offlineOrder(), {
      ...SHOPIFY_CHANNEL,
      status: ChannelStatus.DISCONNECTED,
    });
    await service.pushOrder(ORDER_ID, ORG);
    expect(graphql.request).not.toHaveBeenCalled();
    expect(lastSyncPatch(prisma)).toMatchObject({
      status: 'FAILED',
      error: 'No connected Shopify channel.',
      attempts: 0,
    });
  });

  it('pushes the order without a phone Shopify would reject, instead of failing it', async () => {
    const { service, graphql, prisma } = build(
      offlineOrder({ customer: { externalId: 'manual_x', email: null, phone: '12345' } }),
    );
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await service.pushOrder(ORDER_ID, ORG);

    const input = (graphql.request.mock.calls.find((c) => c[1] === ORDER_CREATE_MUTATION)![2] as any).order;
    expect(input.phone).toBeUndefined();
    expect(lastSyncPatch(prisma)).toMatchObject({ status: 'SYNCED' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#M1001'));
    // The number itself stays out of the log.
    expect(warn.mock.calls.flat().join(' ')).not.toContain('12345');
  });

  it('surfaces orderCreate userErrors so BullMQ retries and nothing is recorded as synced', async () => {
    const { service, graphql, prisma } = build(offlineOrder());
    graphql.request.mockImplementationOnce(async () => ({
      orderCreate: { order: null, userErrors: [{ field: ['order'], message: 'Line item price invalid' }] },
    }));
    await expect(service.pushOrder(ORDER_ID, ORG)).rejects.toThrow(/Line item price invalid/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  // The push used to fulfil every order on Shopify because counter sales were
  // stamped FULFILLED at creation. It now mirrors the header as it stands.
  it('leaves an UNFULFILLED order unfulfilled on Shopify', async () => {
    const { service } = build(offlineOrder({ fulfillmentStatus: 'UNFULFILLED' }));
    const fulfil = jest.spyOn(service as any, 'fulfillEntireOrder').mockResolvedValue(undefined);

    await service.pushOrder(ORDER_ID, ORG);

    expect(fulfil).not.toHaveBeenCalled();
  });

  it('fulfils a FULFILLED order on Shopify at the resolved location', async () => {
    const { service } = build(offlineOrder({ fulfillmentStatus: 'FULFILLED' }));
    const fulfil = jest.spyOn(service as any, 'fulfillEntireOrder').mockResolvedValue(undefined);

    await service.pushOrder(ORDER_ID, ORG);

    expect(fulfil).toHaveBeenCalledTimes(1);
    expect(fulfil).toHaveBeenCalledWith(expect.anything(), 'gid://shopify/Order/6418037801012');
  });
});

describe('isStalePendingSync', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');

  it('is false for anything but PENDING', () => {
    expect(isStalePendingSync(null, now)).toBe(false);
    expect(isStalePendingSync({ status: 'SYNCED' }, now)).toBe(false);
    expect(isStalePendingSync({ status: 'FAILED' }, now)).toBe(false);
  });

  it('trusts a fresh claim and abandons an old one', () => {
    const fresh = new Date(now - 60_000).toISOString();
    const old = new Date(now - STALE_PENDING_SYNC_MS - 1).toISOString();
    expect(isStalePendingSync({ status: 'PENDING', queuedAt: fresh }, now)).toBe(false);
    expect(isStalePendingSync({ status: 'PENDING', queuedAt: old }, now)).toBe(true);
  });

  it('treats a claim with no timestamp (pre-queuedAt rows) or a bad one as stale', () => {
    expect(isStalePendingSync({ status: 'PENDING' }, now)).toBe(true);
    expect(isStalePendingSync({ status: 'PENDING', queuedAt: 'not-a-date' }, now)).toBe(true);
  });
});

describe('readStoredTaxLines', () => {
  it('accepts the REST tax_lines shape and normalises the price to a string', () => {
    expect(
      readStoredTaxLines([
        { title: 'IGST', rate: 0.18, price: '27.00' },
        { title: 'CGST', rate: '0.09', price: 5 },
      ]),
    ).toEqual([
      { title: 'IGST', rate: 0.18, price: '27.00' },
      { title: 'CGST', rate: 0.09, price: '5' },
    ]);
  });

  it('drops malformed entries and non-arrays', () => {
    expect(readStoredTaxLines(null)).toEqual([]);
    expect(readStoredTaxLines({ title: 'x' } as any)).toEqual([]);
    expect(readStoredTaxLines([{ title: 'CGST' }, 'junk', { rate: 0.09, price: '1' }] as any)).toEqual([]);
  });
});

describe('ShopifyPushService — catalogue prices on push', () => {
  // Pushing REBADGES the product onto the destination channel, so its price is
  // afterwards read in that store's currency. Sending the number unchanged
  // therefore re-denominates it: a ₹120 counter-sale product became a $120
  // listing, roughly 95x its intended price.
  const product = (currency: string | null) => ({
    organizationId: 'org_1',
    channel: currency === null ? null : { currency },
  });

  it('restates prices in the destination store currency', async () => {
    const { service, prisma, fx } = build(null);


    const convert = await (service as any).priceConverter(
      product('INR'),
      { id: 'ch_shopify', currency: 'USD' },
      'tok',
      'collabo-test.myshopify.com',
    );

    expect(fx.getRate).toHaveBeenCalledWith('INR', 'USD', expect.any(Date));
    // 120 INR at the stubbed rate of 95 — the point is that it is NOT "120".
    expect(convert(120)).toBe('11400.00');
    expect(convert(null)).toBeNull();
  });

  it('leaves prices alone when both sides use the same currency', async () => {
    const { service, prisma, fx } = build(null);


    const convert = await (service as any).priceConverter(
      product('INR'),
      { id: 'ch_shopify', currency: 'INR' },
      'tok',
      'shop',
    );

    expect(fx.getRate).not.toHaveBeenCalled();
    expect(convert(120)).toBe('120');
  });

  it('refuses the push when a needed rate cannot be reached', async () => {
    // Publishing a wrong price to a live storefront is worse than not
    // publishing, so an unreachable rate fails rather than sending the raw
    // number — which is precisely the bug this replaced.
    const { service, prisma, fx } = build(null);

    fx.getRate.mockResolvedValueOnce(null);

    await expect(
      (service as any).priceConverter(
        product('INR'),
        { id: 'ch_shopify', currency: 'USD' },
        'tok',
        'shop',
      ),
    ).rejects.toThrow(/exchange rate unavailable/i);
  });
});

describe('ShopifyPushService — inventory write to an unstocked location', () => {
  const A = { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/87452614708', quantity: 5 };
  const B = { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/84967948340', quantity: 7 };
  const auth = { shopDomain: 'collabo-test.myshopify.com', accessToken: 'tok' };
  const notStocked = (i: number) => ({
    field: ['input', 'quantities', String(i), 'locationId'],
    message: 'The specified inventory item is not stocked at the location.',
    code: 'ITEM_NOT_STOCKED_AT_LOCATION',
  });

  function withResponses(firstErrors: unknown[]) {
    const { service, graphql } = build(null);
    let setCalls = 0;
    graphql.request.mockImplementation(async (_a: unknown, query: string) => {
      if (query === INVENTORY_ACTIVATE_MUTATION) {
        return { inventoryActivate: { inventoryLevel: { id: 'lvl' }, userErrors: [] } };
      }
      if (query === INVENTORY_SET_QUANTITIES_MUTATION) {
        setCalls += 1;
        return {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: setCalls === 1 ? null : { createdAt: 'now' },
            userErrors: setCalls === 1 ? firstErrors : [],
          },
        };
      }
      return {};
    });
    const calls = (q: string) => graphql.request.mock.calls.filter((c) => c[1] === q);
    return { service, calls };
  }

  it('activates the unstocked pair with its quantity and re-sends only the rest', async () => {
    const { service, calls } = withResponses([notStocked(1)]);
    await (service as any).setInventoryQuantities(auth, [A, B]);

    const activations = calls(INVENTORY_ACTIVATE_MUTATION);
    expect(activations).toHaveLength(1);
    expect(activations[0][2]).toEqual({
      inventoryItemId: B.inventoryItemId,
      locationId: B.locationId,
      available: 7,
    });
    const sets = calls(INVENTORY_SET_QUANTITIES_MUTATION);
    expect(sets).toHaveLength(2);
    expect((sets[1][2] as any).input.quantities).toEqual([A]);
  });

  it('drops a zero for an unstocked pair instead of activating it', async () => {
    const { service, calls } = withResponses([notStocked(1)]);
    await (service as any).setInventoryQuantities(auth, [A, { ...B, quantity: 0 }]);

    expect(calls(INVENTORY_ACTIVATE_MUTATION)).toHaveLength(0);
    const sets = calls(INVENTORY_SET_QUANTITIES_MUTATION);
    expect((sets[1][2] as any).input.quantities).toEqual([A]);
  });

  it('leaves unrelated errors alone (no activation, no retry)', async () => {
    const { service, calls } = withResponses([{ field: null, message: 'Something else' }]);
    await (service as any).setInventoryQuantities(auth, [A, B]);

    expect(calls(INVENTORY_ACTIVATE_MUTATION)).toHaveLength(0);
    expect(calls(INVENTORY_SET_QUANTITIES_MUTATION)).toHaveLength(1);
  });
});

describe('ShopifyPushService — Edit locations', () => {
  const auth = { shopDomain: 'collabo-test.myshopify.com', accessToken: 'tok' };
  const REMOVE = { variantId: 'v1', warehouseId: 'wh_shop', shopifyLocationId: '222', action: 'remove' };
  const ADD = { variantId: 'v1', warehouseId: 'wh_shop', shopifyLocationId: '222', action: 'add' };
  const EMPTY_ROW = { id: 'row_1', available: 0, reserved: 0, qc: 0, damaged: 0 };
  const LEVEL = (quantity = 0) => ({
    id: 'gid://shopify/InventoryLevel/7',
    quantities: [
      { name: 'available', quantity },
      { name: 'on_hand', quantity },
      { name: 'committed', quantity: 0 },
      { name: 'incoming', quantity: 0 },
    ],
  });

  const product = (pending: unknown[]) => ({
    id: 'p1',
    metadata: { shopifySync: { status: 'OUT_OF_SYNC' }, pendingLocationChanges: pending },
  });

  function setup(opts: {
    pending: unknown[];
    level?: ReturnType<typeof LEVEL> | null;
    row?: unknown;
    activateErrors?: unknown[];
    deactivateErrors?: unknown[];
    /** What the list holds when the push re-reads it under the lock. */
    pendingAtWrite?: unknown[];
    inventoryItemId?: string | null;
  }) {
    const built = build(null);
    const prisma = built.prisma as any;
    prisma.productVariant = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'v1', externalId: '9001', inventoryItemId: opts.inventoryItemId === undefined ? '1' : opts.inventoryItemId },
      ]),
      update: jest.fn(),
    };
    prisma.stockLevel = {
      findFirst: jest.fn().mockResolvedValue(opts.row ?? null),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        { metadata: { pendingLocationChanges: opts.pendingAtWrite ?? opts.pending } },
      ]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    prisma.$transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx));
    built.graphql.request.mockImplementation(async (_a: unknown, query: string) => {
      if (query === INVENTORY_LEVEL_AT_LOCATION_QUERY) {
        return { inventoryItem: { inventoryLevel: opts.level === undefined ? LEVEL() : opts.level } };
      }
      if (query === INVENTORY_DEACTIVATE_MUTATION) {
        return { inventoryDeactivate: { userErrors: opts.deactivateErrors ?? [] } };
      }
      if (query === INVENTORY_ACTIVATE_MUTATION) {
        const errors = opts.activateErrors ?? [];
        return {
          inventoryActivate: { inventoryLevel: errors.length ? null : { id: 'lvl' }, userErrors: errors },
        };
      }
      return {};
    });
    const calls = (q: string) => built.graphql.request.mock.calls.filter((c) => c[1] === q);
    /** The pending list written back, or undefined when nothing needed writing. */
    const written = () => {
      const call = tx.$executeRaw.mock.calls.at(-1);
      if (!call) return undefined;
      const json = (call.slice(1) as unknown[]).find(
        (v) => typeof v === 'string' && v.startsWith('{'),
      ) as string;
      return JSON.parse(json).pendingLocationChanges;
    };
    const run = () =>
      (built.service as any).applyPendingLocationChanges(product(opts.pending), 'org_1', auth);
    return { ...built, prisma, calls, written, run };
  }

  describe('removing a location', () => {
    it('un-stocks the variant on Shopify and forgets the change', async () => {
      const { run, calls, written } = setup({ pending: [REMOVE] });

      await run();

      expect(calls(INVENTORY_LEVEL_AT_LOCATION_QUERY)[0][2]).toEqual({
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/222',
      });
      expect(calls(INVENTORY_DEACTIVATE_MUTATION)[0][2]).toEqual({
        inventoryLevelId: 'gid://shopify/InventoryLevel/7',
      });
      expect(written()).toEqual([]);
    });

    it('deletes the empty row a pull put back in the meantime, and only if still empty', async () => {
      const { run, prisma } = setup({ pending: [REMOVE], row: EMPTY_ROW });

      await run();

      expect(prisma.stockLevel.deleteMany).toHaveBeenCalledWith({
        where: { id: 'row_1', available: 0, reserved: 0, qc: 0, damaged: 0 },
      });
    });

    it('keeps the change pending and fails the push when Shopify refuses', async () => {
      const { run, prisma, written } = setup({
        pending: [REMOVE],
        row: EMPTY_ROW,
        deactivateErrors: [{ field: null, message: 'The product must be stocked at one location.' }],
      });

      await expect(run()).rejects.toThrow(/must be stocked at one location/);
      expect(written()).toBeUndefined(); // list unchanged, so nothing rewritten
      expect(prisma.stockLevel.deleteMany).not.toHaveBeenCalled();
    });

    it('does not deactivate a location Shopify holds stock at — that stock would be discarded', async () => {
      const { run, calls, prisma, written } = setup({ pending: [REMOVE], level: LEVEL(6) });

      await run();

      expect(calls(INVENTORY_DEACTIVATE_MUTATION)).toHaveLength(0);
      expect(prisma.stockLevel.deleteMany).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
    });

    it('forgets a removal Shopify already reflects, without calling deactivate', async () => {
      const { run, calls, written } = setup({ pending: [REMOVE], level: null });

      await run();

      expect(calls(INVENTORY_DEACTIVATE_MUTATION)).toHaveLength(0);
      expect(written()).toEqual([]);
    });

    it('never un-stocks a location the CRM holds stock at again', async () => {
      const { run, graphql, written } = setup({
        pending: [REMOVE],
        row: { ...EMPTY_ROW, available: 4 },
      });

      await run();

      expect(graphql.request).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
    });
  });

  describe('adding a location', () => {
    it('stocks the variant there at zero when Shopify does not stock it yet', async () => {
      const { run, calls, written } = setup({ pending: [ADD], level: null, row: EMPTY_ROW });

      await run();

      expect(calls(INVENTORY_ACTIVATE_MUTATION)[0][2]).toEqual({
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/222',
        available: 0,
      });
      expect(written()).toEqual([]);
    });

    it('does not re-activate a location Shopify already stocks', async () => {
      const { run, calls, written } = setup({ pending: [ADD], level: LEVEL(3), row: EMPTY_ROW });

      await run();

      expect(calls(INVENTORY_ACTIVATE_MUTATION)).toHaveLength(0);
      expect(written()).toEqual([]);
    });

    it('keeps the change pending and fails the push when Shopify refuses', async () => {
      const { run, written } = setup({
        pending: [ADD],
        level: null,
        row: EMPTY_ROW,
        activateErrors: [{ field: null, message: 'Location is not active.' }],
      });

      await expect(run()).rejects.toThrow(/Location is not active/);
      expect(written()).toBeUndefined();
    });

    it('drops an add whose row has since been removed', async () => {
      const { run, graphql, written } = setup({ pending: [ADD], row: null });

      await run();

      expect(graphql.request).not.toHaveBeenCalled();
      expect(written()).toEqual([]);
    });
  });

  it('keeps a change made while the push was running, and fails so it is retried', async () => {
    const arrived = { variantId: 'v2', warehouseId: 'wh_shop', shopifyLocationId: '222', action: 'remove' };
    const { run, written } = setup({ pending: [REMOVE], pendingAtWrite: [REMOVE, arrived] });

    await expect(run()).rejects.toThrow(/changed while this sync was running/);
    expect(written()).toEqual([arrived]);
  });

  it('settles a change for a variant that is not on Shopify without calling it', async () => {
    const { run, graphql, written } = setup({ pending: [REMOVE], inventoryItemId: null });
    // No inventory item id, and nothing to backfill it from.
    graphql.request.mockResolvedValue({ productVariant: null });

    await run();

    expect(written()).toEqual([]);
  });

  it('does nothing at all for a product with no pending change', async () => {
    const { run, graphql, prisma } = setup({ pending: [] });

    await run();

    expect(graphql.request).not.toHaveBeenCalled();
    expect(prisma.productVariant.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('ShopifyPushService — which locations a stock push writes to', () => {
  const VARIANT = { id: 'v1', inventoryQuantity: 50 };
  const invIds = new Map([['v1', '1']]);

  /** `mappedRows` are the variant's rows at Shopify locations; `anyRows` at any location. */
  function setup(mappedRows: unknown[], anyRows: unknown[]) {
    const { service, prisma } = build(null);
    const p = prisma as any;
    p.warehouse = {
      findMany: jest.fn().mockResolvedValue([{ id: 'wh_shop', shopifyLocationId: '111' }]),
    };
    p.stockLevel = {
      findMany: jest.fn((args: { where: { warehouseId?: unknown } }) =>
        Promise.resolve(args.where.warehouseId ? mappedRows : anyRows),
      ),
    };
    (service as any).inventoryLedger = { isWarehousingEnabled: jest.fn().mockResolvedValue(true) };
    jest.spyOn(service as any, 'resolveLocationId').mockResolvedValue('999');
    const run = () =>
      (service as any).buildAvailabilityQuantities('org_1', 'ch', 'shop', 'tok', [VARIANT], invIds);
    return { run };
  }

  it('writes each Shopify location its own quantity', async () => {
    const row = { variantId: 'v1', warehouseId: 'wh_shop', available: 7 };
    const { run } = setup([row], [{ variantId: 'v1' }]);

    expect(await run()).toEqual([
      { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/111', quantity: 7 },
    ]);
  });

  it('writes nothing for a variant stocked only at non-Shopify locations', async () => {
    // Its total must NOT land on the primary Shopify location: that stock is
    // somewhere Shopify does not know about.
    const { run } = setup([], [{ variantId: 'v1' }]);

    expect(await run()).toEqual([]);
  });

  it('still falls back to the primary location for a variant with no stock row anywhere', async () => {
    const { run } = setup([], []);

    expect(await run()).toEqual([
      { inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/999', quantity: 50 },
    ]);
  });
});

describe('shopifyOrderPhone', () => {
  const order = (phone: string | null, extra: Record<string, unknown> = {}) => ({
    currency: 'INR',
    shippingAddress: null,
    billingAddress: null,
    customer: { phone },
    ...extra,
  });

  it('adds +91 to a bare Indian number on an INR counter sale with no address', () => {
    expect(shopifyOrderPhone(order('9847586793'))).toEqual({ raw: '9847586793', e164: '+919847586793' });
    expect(shopifyOrderPhone(order('98475 86793')).e164).toBe('+919847586793');
  });

  it("takes the country from the order's address before the currency", () => {
    const us = order('(201) 555-0123', { shippingAddress: { country_code: 'US' } });
    expect(shopifyOrderPhone(us).e164).toBe('+12015550123');
    const billOnly = order('(201) 555-0123', { billingAddress: { country_code: 'us' } });
    expect(shopifyOrderPhone(billOnly).e164).toBe('+12015550123');
  });

  it('passes an E.164 number through, whatever the order currency', () => {
    expect(shopifyOrderPhone(order('+447911123456', { currency: 'USD' })).e164).toBe('+447911123456');
  });

  it('returns no e164 for a number it cannot make valid, but keeps the raw value', () => {
    expect(shopifyOrderPhone(order('12345'))).toEqual({ raw: '12345', e164: null });
    // Bare local number and no way to tell the country.
    expect(shopifyOrderPhone(order('2015550123', { currency: 'USD' })).e164).toBeNull();
  });

  it('is empty when the customer has no phone', () => {
    expect(shopifyOrderPhone(order(null))).toEqual({ raw: null, e164: null });
    expect(shopifyOrderPhone(order('  '))).toEqual({ raw: null, e164: null });
    expect(shopifyOrderPhone({ currency: 'INR', customer: null })).toEqual({ raw: null, e164: null });
  });
});

describe('shopifyOrderCustomer', () => {
  const crm = (over: Record<string, unknown> = {}) => ({
    externalId: 'manual_abc',
    email: 'ana@example.com',
    firstName: 'Ana',
    lastName: 'Lee',
    ...over,
  });

  it('upserts a CRM customer by email WITH the name, so Shopify never holds a nameless copy', () => {
    expect(shopifyOrderCustomer(crm())).toEqual({
      toUpsert: { email: 'ana@example.com', firstName: 'Ana', lastName: 'Lee' },
    });
  });

  it('never puts the phone in the upsert — a clash with another customer fails the whole order', () => {
    const block = shopifyOrderCustomer(crm()) as any;
    expect(block.toUpsert).not.toHaveProperty('phone');
  });

  it('sends no block without an email — Shopify rejects a phone-only upsert', () => {
    // Live on collabo-test, 2026-09-23: "OrderCreateUpsertCustomerAttributesInput
    // requires at least one of id, email" failed a phone-only walk-in's push.
    expect(shopifyOrderCustomer(crm({ email: null }))).toBeUndefined();
    expect(shopifyOrderCustomer(crm({ email: '  ' }))).toBeUndefined();
    expect(shopifyOrderCustomer(null)).toBeUndefined();
  });

  it('omits blank name parts', () => {
    expect(shopifyOrderCustomer(crm({ firstName: '  ', lastName: null }))).toEqual({
      toUpsert: { email: 'ana@example.com' },
    });
  });

  it('associates a customer that came from Shopify by GID, as before', () => {
    expect(shopifyOrderCustomer(crm({ externalId: '7011860054246' }))).toEqual({
      toAssociate: { id: 'gid://shopify/Customer/7011860054246' },
    });
  });
});

describe('ShopifyPushService.pushOrder — addresses', () => {
  const kochi = {
    first_name: 'Ana', last_name: 'Lee', address1: '7 Marine Drive', city: 'Kochi',
    zip: '682031', stateCode: '32', province: 'Kerala', country_code: 'IN',
  };

  async function pushedInput(overrides: Record<string, unknown>) {
    const { service, graphql } = build(offlineOrder(overrides));
    await service.pushOrder(ORDER_ID, ORG);
    return (graphql.request.mock.calls.find((c) => c[1] === ORDER_CREATE_MUTATION)![2] as any).order;
  }

  it('sends the delivery address, and uses it for billing when there is no separate one', async () => {
    const input = await pushedInput({ shippingAddress: kochi, billingAddress: null });
    const expected = {
      firstName: 'Ana', lastName: 'Lee', address1: '7 Marine Drive', city: 'Kochi',
      zip: '682031', provinceCode: 'KL', countryCode: 'IN',
    };
    expect(input.shippingAddress).toEqual(expected);
    expect(input.billingAddress).toEqual(expected);
  });

  it('sends a separate billing address when there is one', async () => {
    const input = await pushedInput({
      shippingAddress: kochi,
      billingAddress: { address1: '4 Park St', city: 'Kolkata', stateCode: '19' },
    });
    expect(input.billingAddress).toMatchObject({ address1: '4 Park St', provinceCode: 'WB' });
  });

  it('sends no address keys for a counter sale without one', async () => {
    const input = await pushedInput({ shippingAddress: null, billingAddress: null });
    expect(input).not.toHaveProperty('shippingAddress');
    expect(input).not.toHaveProperty('billingAddress');
  });
});

describe('ShopifyPushService.pushOrder — address without a country', () => {
  it('sends India for an INR order so Shopify does not fall back to the store country', async () => {
    const { service, graphql } = build(
      offlineOrder({ shippingAddress: { address1: 'Ernakulam Kerala', city: 'Ernakulam', zip: '682509' }, billingAddress: null }),
    );
    await service.pushOrder(ORDER_ID, ORG);
    const input = (graphql.request.mock.calls.find((c) => c[1] === ORDER_CREATE_MUTATION)![2] as any).order;
    expect(input.shippingAddress.countryCode).toBe('IN');
    expect(input.billingAddress.countryCode).toBe('IN');
  });
});
