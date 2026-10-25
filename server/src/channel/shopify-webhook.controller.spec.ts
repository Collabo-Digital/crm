import { createHmac } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { ShopifyWebhookController } from './shopify-webhook.controller';

const SECRET = 'app-secret';
const SHOP = 'kochi-sarees.myshopify.com';

const CONNECTED = {
  id: 'ch_1',
  organizationId: 'org_1',
  platform: ChannelPlatform.SHOPIFY,
  status: ChannelStatus.CONNECTED,
  isEnabled: true,
  externalStoreId: '2002',
  externalStoreUrl: `https://${SHOP}`,
  credentials: { shopDomain: SHOP },
  metadata: { webPixelId: 'px' },
};

function build(opts: { candidates?: unknown[]; redactChannels?: unknown[] } = {}) {
  const prisma = {
    channel: {
      findMany: jest.fn(async ({ where }: any) =>
        where.OR ? (opts.redactChannels ?? []) : (opts.candidates ?? [CONNECTED]),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    customer: {
      findMany: jest.fn().mockResolvedValue([{ id: 'cust_1' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    checkout: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    rawAnalyticsEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const syncService = { upsertOrder: jest.fn().mockResolvedValue(undefined) };
  const checkouts = { markCompleted: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(SECRET) };
  const controller = new ShopifyWebhookController(
    prisma as any, {} as any, syncService as any, checkouts as any, config as any, {} as any,
  );
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn((controller as any).logger, level).mockImplementation(() => undefined);
  }
  return { controller, prisma, syncService, checkouts };
}

function deliver(controller: ShopifyWebhookController, topic: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const hmac = createHmac('sha256', SECRET).update(raw).digest('base64');
  return controller.handleWebhook({ rawBody: raw } as any, hmac, topic, SHOP);
}

/** The SQL text of an $executeRaw tagged-template call. */
function sqlOf(call: unknown[]) {
  return (call[0] as TemplateStringsArray).join('?');
}

describe('ShopifyWebhookController — app/uninstalled', () => {
  it('releases the store so another workspace can connect it, and remembers it for a reinstall', async () => {
    const { controller, prisma } = build();

    await deliver(controller, 'app/uninstalled', { id: 2002 });

    const { data } = prisma.channel.update.mock.calls[0][0];
    expect(data).toMatchObject({
      status: ChannelStatus.DISCONNECTED,
      isEnabled: false,
      externalStoreId: null,
      externalStoreUrl: null,
    });
    expect(data.metadata).toMatchObject({ webPixelId: 'px', externalAccountId: '2002' });
  });
});

describe('ShopifyWebhookController — GDPR redaction', () => {
  it('shop/redact finds a disconnected channel by shop id and redacts everything it holds', async () => {
    const released = { id: 'ch_old', organizationId: 'org_1' };
    const { controller, prisma } = build({ candidates: [], redactChannels: [released] });

    await deliver(controller, 'shop/redact', { shop_id: 2002, shop_domain: SHOP });

    const lookup = prisma.channel.findMany.mock.calls.find((c: any) => c[0].where.OR)![0];
    expect(lookup.where.OR).toEqual(
      expect.arrayContaining([
        { metadata: { path: ['externalAccountId'], equals: '2002' } },
      ]),
    );
    expect(prisma.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['cust_1'] } } }),
    );
    expect(prisma.checkout.updateMany).toHaveBeenCalledWith({
      where: { channelId: 'ch_old' },
      data: { email: null, phone: null, firstName: null, recoveryUrl: null },
    });
    const statements = prisma.$executeRaw.mock.calls.map(sqlOf);
    expect(statements.some((s) => s.includes('UPDATE orders'))).toBe(true);
    expect(statements.some((s) => s.includes('UPDATE raw_analytics_events'))).toBe(true);
  });

  it("customers/redact limits the work to that customer's rows", async () => {
    const { controller, prisma } = build({ redactChannels: [{ id: 'ch_1', organizationId: 'org_1' }] });

    await deliver(controller, 'customers/redact', {
      shop_id: 2002,
      customer: { id: 555, email: 'ana@example.com', phone: '+919800000000' },
      orders_to_redact: [9001, 9002],
    });

    expect(prisma.customer.findMany.mock.calls[0][0].where).toMatchObject({ externalId: '555' });
    expect(prisma.checkout.updateMany.mock.calls[0][0].where).toEqual({
      channelId: 'ch_1',
      OR: [
        { customerExternalId: '555' },
        { email: 'ana@example.com' },
        { phone: '+919800000000' },
      ],
    });
    const orderUpdate = prisma.$executeRaw.mock.calls.find((c: unknown[]) => sqlOf(c).includes('UPDATE orders'))!;
    // The order scope fragment carries the Shopify order ids to redact.
    expect(JSON.stringify(orderUpdate)).toContain('9001');
  });
});

describe('ShopifyWebhookController — inventory_levels/update for a warehousing org', () => {
  // Two quick sales send available 9 then 8. Both handlers used to read 10
  // outside any lock and apply -1 and -2, leaving 7 against Shopify's 8.
  it('reads the level behind the variant lock, in the same transaction as the movement', async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn(async () => { order.push('lock'); return []; }),
      stockLevel: { findFirst: jest.fn(async () => { order.push('read'); return { available: 9 }; }) },
    };
    const prisma = {
      warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'wh_1' }) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const ledger = { applyMovement: jest.fn(async () => { order.push('move'); return { skipped: false }; }) };
    const controller = new ShopifyWebhookController(
      prisma as any, {} as any, {} as any, {} as any, { get: jest.fn() } as any, ledger as any,
    );
    jest.spyOn((controller as any).logger, 'log').mockImplementation(() => undefined);

    await (controller as any).applyWarehousedInventoryUpdate('org_1', 'var_1', { available: 8, location_id: 42 });

    expect(order).toEqual(['lock', 'read', 'move']);
    expect(ledger.applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 1, fromBucket: 'AVAILABLE', toBucket: null }),
      tx,
    );
  });
});

describe('ShopifyWebhookController — order webhooks', () => {
  const order = { id: 9001, checkout_id: 77, checkout_token: 'tok' };

  it('completes the checkout before the order write, so a paying buyer gets no cart reminder', async () => {
    const { controller, syncService, checkouts } = build();
    syncService.upsertOrder.mockRejectedValue(new TypeError('bad payload'));

    await expect(deliver(controller, 'orders/updated', order)).resolves.toEqual({ received: true });

    expect(checkouts.markCompleted).toHaveBeenCalledWith(CONNECTED, order);
    expect(checkouts.markCompleted.mock.invocationCallOrder[0]).toBeLessThan(
      syncService.upsertOrder.mock.invocationCallOrder[0],
    );
  });

  it('answers 503 on a brief database failure so Shopify delivers the order again', async () => {
    const { controller, syncService } = build();
    syncService.upsertOrder.mockRejectedValue(
      new PrismaClientKnownRequestError('pool timeout', { code: 'P2024', clientVersion: 'test' }),
    );

    await expect(deliver(controller, 'orders/create', order)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe.each([
  ['an org without warehousing', false],
  ['a warehousing org', true],
])('ShopifyWebhookController — inventory_levels/update out of order, %s', (_name, warehousing) => {
  // One stock level, held where each path keeps it: the variant's quantity, or
  // the warehouse's AVAILABLE bucket.
  function build(start: { qty: number; at: string }) {
    const level = { qty: start.qty, at: new Date(start.at) as Date | null };
    const tx = {
      $queryRaw: jest.fn(async () => [{ inventory_quantity: level.qty, shopify_inventory_updated_at: level.at }]),
      productVariant: {
        update: jest.fn(async ({ data }: any) => {
          level.qty = data.inventoryQuantity;
          if (data.shopifyInventoryUpdatedAt) level.at = data.shopifyInventoryUpdatedAt;
        }),
      },
      inventoryEvent: { create: jest.fn().mockResolvedValue({}) },
      stockLevel: {
        findFirst: jest.fn(async () => ({ available: level.qty, shopifyUpdatedAt: level.at })),
        updateMany: jest.fn(async ({ data }: any) => {
          level.at = data.shopifyUpdatedAt;
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      productVariant: { findFirst: jest.fn().mockResolvedValue({ id: 'var_1', inventoryQuantity: start.qty }) },
      warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'wh_1' }) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const ledger = {
      isWarehousingEnabled: jest.fn().mockResolvedValue(warehousing),
      applyMovement: jest.fn(async (m: any) => {
        level.qty += m.toBucket ? m.quantity : -m.quantity;
        return { skipped: false };
      }),
    };
    const controller = new ShopifyWebhookController(
      prisma as any, {} as any, {} as any, {} as any, { get: jest.fn() } as any, ledger as any,
    );
    for (const l of ['log', 'debug'] as const) {
      jest.spyOn((controller as any).logger, l).mockImplementation(() => undefined);
    }
    const deliver = (available: number, updatedAt: string) =>
      (controller as any).handleInventoryUpdate('ch_1', 'org_1', {
        inventory_item_id: 501, location_id: 42, available, updated_at: updatedAt,
      });
    // Stock history rows: inventory events directly, or ledger movements.
    const historyRows = () =>
      warehousing ? ledger.applyMovement.mock.calls.length : tx.inventoryEvent.create.mock.calls.length;
    return { level, deliver, historyRows };
  }

  // Shopify's own format, with the shop's offset.
  const T0 = '2026-10-25T15:30:00+05:30';
  const T1 = '2026-10-25T15:30:01+05:30';
  const T2 = '2026-10-25T15:30:02+05:30';
  const T3 = '2026-10-25T15:30:03+05:30';

  it('ignores the 9 of 10 → 9 → 8 when it arrives after the 8', async () => {
    const { level, deliver, historyRows } = build({ qty: 10, at: T0 });

    await deliver(8, T2);
    await deliver(9, T1);

    expect(level.qty).toBe(8);
    expect(level.at).toEqual(new Date(T2));
    expect(historyRows()).toBe(1);
  });

  it('applies a newer update and keeps its time', async () => {
    const { level, deliver } = build({ qty: 8, at: T1 });

    await deliver(7, T3);

    expect(level.qty).toBe(7);
    expect(level.at).toEqual(new Date(T3));
  });

  it('applies an update with the same time as the stored one', async () => {
    const { level, deliver } = build({ qty: 9, at: T1 });

    await deliver(8, T1);

    expect(level.qty).toBe(8);
  });

  it("still takes the echo of the CRM's own push: no stock history, and an older update after it is ignored", async () => {
    // The merchant set 12 in the CRM, which pushed it; Shopify echoes 12.
    const { level, deliver, historyRows } = build({ qty: 12, at: T0 });

    await deliver(12, T3);
    await deliver(10, T2);

    expect(level.qty).toBe(12);
    expect(level.at).toEqual(new Date(T3));
    expect(historyRows()).toBe(0);
  });
});
