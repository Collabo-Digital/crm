import { ChannelPlatform, ChannelStatus, Prisma } from '@prisma/client';
import {
  ShopifyPushService,
  isStalePendingSync,
  readStoredTaxLines,
  STALE_PENDING_SYNC_MS,
} from './shopify-push.service';
import { ORDER_CREATE_MUTATION } from './shopify-graphql.types';

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

    // Walk-in customer rides as phone; no toAssociate for a manual_ id.
    expect(input.customer).toBeUndefined();
    expect(input.phone).toBe('9847586793');
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

  it('surfaces orderCreate userErrors so BullMQ retries and nothing is recorded as synced', async () => {
    const { service, graphql, prisma } = build(offlineOrder());
    graphql.request.mockImplementationOnce(async () => ({
      orderCreate: { order: null, userErrors: [{ field: ['order'], message: 'Line item price invalid' }] },
    }));
    await expect(service.pushOrder(ORDER_ID, ORG)).rejects.toThrow(/Line item price invalid/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
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
