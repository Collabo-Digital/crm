import { GstCalculatorService } from '../gst/gst-calculator.service';
import { OrderService } from './order.service';

/**
 * A draft priced with GST included (a WhatsApp cart from a tax-inclusive
 * store) completes into a counter sale. The sale must charge what the draft
 * quoted — the payment link was for that amount — not add GST on top again.
 */
/**
 * `pricesIncludeTax` is the org's "Catalogue prices include GST" choice
 * (null: not made); `storeTaxesIncluded` is what its latest Shopify order
 * says (undefined: none synced).
 */
function build(opts: { pricesIncludeTax?: boolean | null; storeTaxesIncluded?: boolean; composition?: boolean } = {}) {
  const tx: any = {
    channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'cust_1', billingStateCode: null, gstin: null }),
    },
    productVariant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'var_1',
          title: 'Default',
          sku: 'SKU-1',
          price: 1180,
          gstRate: null,
          taxable: true,
          trackQuantity: false,
          continueSellingWhenOutOfStock: true,
          inventoryQuantity: 50,
          product: { id: 'prod_1', title: 'Shirt', vendor: null, vendorKey: null, gstRate: 18, channel: { currency: 'INR' } },
        },
      ]),
      update: jest.fn().mockResolvedValue({ inventoryQuantity: 49 }),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ gstEnabled: true, currency: 'INR' }) },
    organizationGstin: { findFirst: jest.fn().mockResolvedValue({ stateCode: '29' }) },
    organizationSettings: {
      findUnique: jest.fn().mockResolvedValue({ taxSettings: { composition: opts.composition ?? false } }),
    },
    order: {
      findFirst: jest.fn().mockResolvedValue({ orderNumber: 1000 }),
      create: jest.fn().mockResolvedValue({ id: 'order_1', name: '#M1001', lineItems: [{ id: 'li_1' }] }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    orderLineItem: {
      findMany: jest.fn().mockResolvedValue([{ fulfillmentStatus: null, quantity: 1, fulfilledQuantity: 0 }]),
    },
    warehouse: { findFirst: jest.fn().mockResolvedValue(null) },
    inventoryEvent: { create: jest.fn().mockResolvedValue(undefined) },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue(undefined) },
  };
  // The org's basis is read on the root client, outside the sale's
  // Serializable transaction.
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    organizationSettings: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ taxSettings: { pricesIncludeTax: opts.pricesIncludeTax ?? null } }),
    },
    order: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.storeTaxesIncluded === undefined ? null : { taxesIncluded: opts.storeTaxesIncluded },
        ),
    },
  };
  const service = new OrderService(
    prisma,
    new GstCalculatorService(),
    { resolveLineGstRates: jest.fn().mockResolvedValue([18]) } as any,
    { createForOrderTx: jest.fn().mockResolvedValue({ id: 'inv_1' }) } as any,
    { enqueueOrderPush: jest.fn().mockResolvedValue(true) } as any,
    { findShopifyChannel: jest.fn().mockResolvedValue(null), recordFailure: jest.fn() } as any,
    {} as any,
    {} as any,
    {
      getProductSettings: jest.fn().mockResolvedValue({ trackQuantityGlobally: false, allowOversellGlobally: true }),
      getOrderSettings: jest.fn().mockResolvedValue({ autoSyncToShopify: false }),
    } as any,
    { recomputeForCustomer: jest.fn().mockResolvedValue(undefined) } as any,
    { isWarehousingEnabled: jest.fn().mockResolvedValue(false), applyMovement: jest.fn() } as any,
    { getRate: jest.fn() } as any,
    { add: jest.fn() } as any,
    { order: jest.fn(), invoiceIssued: jest.fn() } as any,
  );
  jest.spyOn(service as any, 'markPendingSync').mockResolvedValue(undefined);
  return { service, tx, prisma };
}

const dto = (over: Record<string, unknown> = {}) =>
  ({
    customer: { firstName: 'Walk', lastName: 'In', phone: '9000000000' },
    lineItems: [{ productVariantId: 'var_1', quantity: 1, unitPriceOverride: 1180 }],
    paymentMethod: 'UPI',
    sellerGstinId: 'gstin_1',
    ...over,
  }) as any;

describe('createOfflineOrder pricing', () => {
  it('charges a tax-inclusive price as it is, with the GST inside it', async () => {
    const { service, tx } = build();

    await service.createOfflineOrder('org_1', 'user_1', dto({ pricesIncludeTax: true }));

    const data = tx.order.create.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({ totalPrice: 1180, totalTax: 180, subtotalPrice: 1180, taxesIncluded: true }),
    );
    expect(data.lineItems.create[0]).toEqual(expect.objectContaining({ price: 1180, channelTaxAmount: 180 }));
  });

  it('takes the GST out of a typed price when the org says prices include it', async () => {
    const { service, tx } = build({ pricesIncludeTax: true });

    await service.createOfflineOrder('org_1', 'user_1', dto());

    const data = tx.order.create.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({ totalPrice: 1180, totalTax: 180, subtotalPrice: 1180, taxesIncluded: true }),
    );
    // ₹1,000 taxable, split CGST + SGST inside the ₹1,180.
    expect(data.lineItems.create[0]).toEqual(
      expect.objectContaining({
        price: 1180,
        channelTaxAmount: 180,
        channelTaxLines: [
          { title: 'CGST', rate: 0.09, price: '90.00' },
          { title: 'SGST', rate: 0.09, price: '90.00' },
        ],
      }),
    );
  });

  it('takes the GST out of a catalogue price too', async () => {
    const { service, tx } = build({ pricesIncludeTax: true });

    await service.createOfflineOrder('org_1', 'user_1', dto({ lineItems: [{ productVariantId: 'var_1', quantity: 1 }] }));

    expect(tx.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ totalPrice: 1180, totalTax: 180, taxesIncluded: true }),
    );
  });

  it('reads an unset choice from the store’s own Shopify orders', async () => {
    const { service, tx } = build({ storeTaxesIncluded: true });

    await service.createOfflineOrder('org_1', 'user_1', dto());

    expect(tx.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ totalPrice: 1180, totalTax: 180, taxesIncluded: true }),
    );
  });

  it('lets the org’s choice override what its Shopify orders say', async () => {
    const { service, tx, prisma } = build({ pricesIncludeTax: false, storeTaxesIncluded: true });

    await service.createOfflineOrder('org_1', 'user_1', dto({ lineItems: [{ productVariantId: 'var_1', quantity: 1, unitPriceOverride: 1000 }] }));

    expect(tx.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ totalPrice: 1180, totalTax: 180, subtotalPrice: 1000, taxesIncluded: false }),
    );
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('charges a completing draft on the basis it was quoted, whatever the org says now', async () => {
    const { service, tx, prisma } = build({ pricesIncludeTax: true });

    await service.createOfflineOrder(
      'org_1',
      'user_1',
      dto({ pricesIncludeTax: false, lineItems: [{ productVariantId: 'var_1', quantity: 1, unitPriceOverride: 1000 }] }),
    );

    expect(tx.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ totalPrice: 1180, totalTax: 180, taxesIncluded: false }),
    );
    expect(prisma.organizationSettings.findUnique).not.toHaveBeenCalled();
  });

  it('adds GST on top of an ordinary counter-sale price', async () => {
    const { service, tx } = build();

    await service.createOfflineOrder('org_1', 'user_1', dto({ lineItems: [{ productVariantId: 'var_1', quantity: 1, unitPriceOverride: 1000 }] }));

    expect(tx.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ totalPrice: 1180, totalTax: 180, subtotalPrice: 1000, taxesIncluded: false }),
    );
  });
});

/**
 * A seller under the composition scheme cannot supply to another state (CGST
 * Act section 10(2)(c)), so a counter sale or till bill to one is refused
 * outright: made, it could never be invoiced.
 */
describe('createOfflineOrder under the composition scheme', () => {
  /** The harness, with the one mock these read given a type. */
  const sale = (composition?: boolean) => {
    const built = build({ composition });
    return { service: built.service, createOrder: (built.tx as { order: { create: jest.Mock } }).order.create };
  };

  it('refuses a sale to another state, naming both states, and makes nothing', async () => {
    const { service, createOrder } = sale(true);

    await expect(
      service.createOfflineOrder('org_1', 'user_1', dto({ placeOfSupplyCode: '32' })),
    ).rejects.toThrow(
      "You're registered under the GST composition scheme, which doesn't allow sales to another state. " +
        "This sale's place of supply is Kerala (32); your registration is in Karnataka (29).",
    );
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('refuses an export, which is a sale to another state too', async () => {
    const { service } = sale(true);

    await expect(
      service.createOfflineOrder('org_1', 'user_1', dto({ placeOfSupplyCode: '96' })),
    ).rejects.toThrow("This sale's place of supply is Other Country (96); your registration is in Karnataka (29).");
  });

  it('makes a sale within the state', async () => {
    const { service, createOrder } = sale(true);

    await service.createOfflineOrder('org_1', 'user_1', dto());

    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it('still makes a sale to another state for a regular seller', async () => {
    const { service, createOrder } = sale(false);

    await service.createOfflineOrder('org_1', 'user_1', dto({ placeOfSupplyCode: '32' }));

    const [[{ data }]] = createOrder.mock.calls as [[{ data: object }]];
    expect(data).toMatchObject({ placeOfSupplyCode: '32', gstType: 'IGST' });
  });
});
