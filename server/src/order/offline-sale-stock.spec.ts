import { OrderService } from './order.service';
import { StockBucket } from '@prisma/client';

/**
 * A counter sale must take its units OUT OF A WAREHOUSE, not off the cache.
 *
 * `createOfflineOrder` used to do `inventoryQuantity: { decrement }` straight
 * onto the variant. For a warehousing org that column is a derived cache
 * (SUM(stock_levels.available)) which `applyMovement` recomputes, so the sold
 * units left no bucket and the next movement — an adjustment, or the Shopify
 * per-location reconcile — put them straight back. Observed on DEV 2026-09-05:
 * QA-2026-S-RED sold 2, cache 30 → 28, Kerala stayed at 30, and the next sync
 * restored the cache to 55.
 *
 * This is the sale-side mirror of `cancel-restock.spec.ts`, and the two must
 * resolve the SAME warehouse or a sale and its cancellation drift apart.
 */

const ORG = 'org_1';
const USER = 'user_1';
const VARIANT = 'var_1';

function build({
  warehousing,
  warehouseId = null as string | null,
  variantChannelCurrency = 'INR' as string | null,
  price = 100,
  rate = null as number | null,
  autoSyncToShopify = false,
}) {
  const created = {
    id: 'order_1',
    name: '#M1001',
    lineItems: [{ id: 'li_1' }],
  };
  const tx: any = {
    channel: { upsert: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'cust_1', billingStateCode: null, gstin: null }),
    },
    productVariant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: VARIANT,
          title: 'Default',
          sku: 'SKU-1',
          price,
          gstRate: null,
          taxable: true,
          trackQuantity: true,
          continueSellingWhenOutOfStock: false,
          inventoryQuantity: 50,
          product: {
            id: 'prod_1',
            title: 'Widget',
            vendor: 'Acme',
            vendorKey: null,
            gstRate: null,
            channel: { currency: variantChannelCurrency },
          },
        },
      ]),
      update: jest.fn().mockResolvedValue({ inventoryQuantity: 48 }),
    },
    // GST off: the invoice branch is not what this spec is about.
    organization: { findUnique: jest.fn().mockResolvedValue({ gstEnabled: false, currency: 'INR' }) },
    organizationGstin: { findMany: jest.fn().mockResolvedValue([]) },
    order: {
      findFirst: jest.fn().mockResolvedValue({ orderNumber: 1000 }),
      create: jest.fn().mockResolvedValue(created),
    },
    warehouse: {
      // Two different lookups hit this: resolving an explicitly picked dispatch
      // warehouse (by id) and falling back to the org default (by isDefault).
      findFirst: jest.fn(async ({ where }: any) =>
        where?.id ? { id: where.id } : warehouseId ? { id: warehouseId } : null,
      ),
    },
    inventoryEvent: { create: jest.fn().mockResolvedValue(undefined) },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue(undefined) },
  };
  const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  const ledger = {
    isWarehousingEnabled: jest.fn().mockResolvedValue(warehousing),
    applyMovement: jest.fn().mockResolvedValue({ skipped: false, inventoryQuantity: 48 }),
  };
  const settings = {
    getProductSettings: jest.fn().mockResolvedValue({
      trackQuantityGlobally: true,
      allowOversellGlobally: false,
    }),
    getOrderSettings: jest.fn().mockResolvedValue({
      autoSyncToShopify: autoSyncToShopify,
    }),
  };
  const shopifyPushQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const shopifyPushService = {
    findShopifyChannel: jest.fn().mockResolvedValue(
      autoSyncToShopify ? { status: 'CONNECTED' } : null,
    ),
    recordFailure: jest.fn().mockResolvedValue(undefined),
  };
  const fx = { getRate: jest.fn().mockResolvedValue(rate) };

  const service = new OrderService(
    prisma,
    { toNumber: (v: any) => Number(v), toNullableNumber: () => null, round2: (n: number) => Math.round(n * 100) / 100, calculateLineItem: ({ unitPrice, quantity }: any) => ({ taxableValue: unitPrice * quantity, totalTax: 0, totalAmount: unitPrice * quantity, cgstRate: 0, sgstRate: 0, igstRate: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0 }) } as any,
    { resolveLineGstRates: jest.fn().mockResolvedValue([0]) } as any,
    { createForOrderTx: jest.fn() } as any,
    { enqueueOrderPush: jest.fn().mockResolvedValue(true) } as any,
    shopifyPushService as any,
    {} as any,
    {} as any,
    settings as any,
    { recomputeForCustomer: jest.fn().mockResolvedValue(undefined) } as any,
    ledger as any,
    fx as any,
    shopifyPushQueue as any,
  );
  // `markPendingSync` writes through prisma.order.update, which this harness
  // does not stub — the push path is what is under test, not that write.
  jest.spyOn(service as any, 'markPendingSync').mockResolvedValue(undefined);
  return { service, tx, ledger, fx, shopifyPushQueue, settings };
}

const dto = (over: Record<string, unknown> = {}) =>
  ({
    customer: { firstName: 'Walk', lastName: 'In', phone: '9000000000' },
    lineItems: [{ productVariantId: VARIANT, quantity: 2 }],
    paymentMethod: 'CASH',
    generateInvoice: false,
    ...over,
  }) as any;

describe('createOfflineOrder — stock leaves a warehouse', () => {
  it('moves stock out of AVAILABLE through the ledger for a warehousing org', async () => {
    const { service, tx, ledger } = build({ warehousing: true, warehouseId: 'wh_default' });

    await service.createOfflineOrder(ORG, USER, dto());

    expect(ledger.applyMovement).toHaveBeenCalledTimes(1);
    expect(ledger.applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: VARIANT,
        warehouseId: 'wh_default',
        fromBucket: StockBucket.AVAILABLE,
        toBucket: null,
        quantity: 2,
        reason: 'sale',
      }),
      tx,
    );
    // The cache is the ledger's to recompute — never written behind its back.
    expect(tx.productVariant.update).not.toHaveBeenCalled();
  });

  it('takes stock from the order’s dispatch warehouse when one was chosen', async () => {
    const { service, ledger } = build({ warehousing: true, warehouseId: 'wh_default' });

    await service.createOfflineOrder(ORG, USER, dto({ warehouseId: 'wh_picked' }));

    expect(ledger.applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseId: 'wh_picked' }),
      expect.anything(),
    );
  });

  it('refuses the sale when warehousing is on but no warehouse can be resolved', async () => {
    const { service, ledger } = build({ warehousing: true, warehouseId: null });

    await expect(service.createOfflineOrder(ORG, USER, dto())).rejects.toThrow(
      /no default warehouse/i,
    );
    expect(ledger.applyMovement).not.toHaveBeenCalled();
  });

  it('still decrements the variant directly for a legacy (non-warehousing) org', async () => {
    const { service, tx, ledger } = build({ warehousing: false });

    await service.createOfflineOrder(ORG, USER, dto());

    expect(ledger.applyMovement).not.toHaveBeenCalled();
    expect(tx.productVariant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { inventoryQuantity: { decrement: 2 } } }),
    );
  });
});

describe('createOfflineOrder — catalogue prices are restated in the order currency', () => {
  it('converts a foreign-currency catalogue price before charging it', async () => {
    // A $120 variant on a USD Shopify channel, sold at an INR counter.
    const { service, tx, fx } = build({
      warehousing: false,
      variantChannelCurrency: 'USD',
      price: 120,
      rate: 94.5,
    });

    await service.createOfflineOrder(ORG, USER, dto());

    expect(fx.getRate).toHaveBeenCalledWith('USD', 'INR', expect.any(Date));
    const line = tx.order.create.mock.calls[0][0].data.lineItems.create[0];
    expect(line.price).toBeCloseTo(11340, 2); // 120 × 94.5, not 120
  });

  it('leaves a same-currency price alone and asks for no rate', async () => {
    const { service, tx, fx } = build({
      warehousing: false,
      variantChannelCurrency: 'INR',
      price: 120,
    });

    await service.createOfflineOrder(ORG, USER, dto());

    expect(fx.getRate).not.toHaveBeenCalled();
    expect(tx.order.create.mock.calls[0][0].data.lineItems.create[0].price).toBe(120);
  });

  it('refuses to guess when the rate is unavailable', async () => {
    const { service } = build({
      warehousing: false,
      variantChannelCurrency: 'USD',
      price: 120,
      rate: null,
    });

    await expect(service.createOfflineOrder(ORG, USER, dto())).rejects.toThrow(
      /exchange rate is available/i,
    );
  });

  it('honours a price the cashier typed, without converting it', async () => {
    const { service, tx } = build({
      warehousing: false,
      variantChannelCurrency: 'USD',
      price: 120,
      rate: 94.5,
    });

    await service.createOfflineOrder(
      ORG,
      USER,
      dto({ lineItems: [{ productVariantId: VARIANT, quantity: 2, unitPriceOverride: 500 }] }),
    );

    expect(tx.order.create.mock.calls[0][0].data.lineItems.create[0].price).toBe(500);
  });
});

/**
 * A local counter sale moves real stock, but Shopify wins on the next pull —
 * so unless the new quantity is pushed, the per-location reconcile puts the
 * sold units straight back and the sale silently un-sells itself.
 *
 * The guard matters as much as the push: when the ORDER goes to Shopify,
 * Shopify decrements its own inventory for it, and setting availability on top
 * of that would take the units off twice.
 */
describe('createOfflineOrder - the sold quantity reaches Shopify', () => {
  it('pushes availability for a sale that stays local', async () => {
    const { service, shopifyPushQueue } = build({
      warehousing: true,
      warehouseId: 'wh_default',
      autoSyncToShopify: false,
    });

    await service.createOfflineOrder(ORG, USER, dto());

    expect(shopifyPushQueue.add).toHaveBeenCalledWith(
      'push-availability',
      expect.objectContaining({
        type: 'push-availability',
        organizationId: ORG,
        variantIds: [VARIANT],
      }),
      expect.anything(),
    );
  });

  it('does NOT push availability when the order itself went to Shopify', async () => {
    const { service, shopifyPushQueue } = build({
      warehousing: true,
      warehouseId: 'wh_default',
      autoSyncToShopify: true,
    });

    await service.createOfflineOrder(ORG, USER, dto());

    const availabilityPushes = shopifyPushQueue.add.mock.calls.filter(
      ([name]: [string]) => name === 'push-availability',
    );
    expect(availabilityPushes).toHaveLength(0);
  });

  it('pushes for a legacy org too - the cache is what Shopify is told', async () => {
    const { service, shopifyPushQueue } = build({
      warehousing: false,
      autoSyncToShopify: false,
    });

    await service.createOfflineOrder(ORG, USER, dto());

    expect(shopifyPushQueue.add).toHaveBeenCalledWith(
      'push-availability',
      expect.objectContaining({ variantIds: [VARIANT] }),
      expect.anything(),
    );
  });

  it('pushes nothing when the sale moved no stock', async () => {
    const { service, shopifyPushQueue, settings, tx } = build({
      warehousing: true,
      warehouseId: 'wh_default',
      autoSyncToShopify: false,
    });
    // Untracked on the variant AND no org-wide override: the loop skips the
    // line entirely, so no stock moved and there is nothing to tell Shopify.
    settings.getProductSettings.mockResolvedValue({
      trackQuantityGlobally: false,
      allowOversellGlobally: true,
    });
    const [variant] = await tx.productVariant.findMany();
    tx.productVariant.findMany.mockResolvedValue([
      { ...variant, trackQuantity: false },
    ]);

    await service.createOfflineOrder(
      ORG,
      USER,
      dto({ lineItems: [{ productVariantId: VARIANT, quantity: 2 }] }),
    );

    const availabilityPushes = shopifyPushQueue.add.mock.calls.filter(
      ([name]: [string]) => name === 'push-availability',
    );
    expect(availabilityPushes).toHaveLength(0);
  });

  it('survives a queue outage without failing the sale', async () => {
    const { service, shopifyPushQueue } = build({
      warehousing: true,
      warehouseId: 'wh_default',
      autoSyncToShopify: false,
    });
    shopifyPushQueue.add.mockRejectedValue(new Error('redis down'));

    await expect(
      service.createOfflineOrder(ORG, USER, dto()),
    ).resolves.toBeDefined();
  });
});
