import { GstCalculatorService } from '../gst/gst-calculator.service';
import { OrderService } from './order.service';

/**
 * A draft priced with GST included (a WhatsApp cart from a tax-inclusive
 * store) completes into a counter sale. The sale must charge what the draft
 * quoted — the payment link was for that amount — not add GST on top again.
 */
function build() {
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
  const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
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
  return { service, tx };
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

  it('adds GST on top of an ordinary counter-sale price', async () => {
    const { service, tx } = build();

    await service.createOfflineOrder('org_1', 'user_1', dto({ lineItems: [{ productVariantId: 'var_1', quantity: 1, unitPriceOverride: 1000 }] }));

    expect(tx.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ totalPrice: 1180, totalTax: 180, subtotalPrice: 1000, taxesIncluded: false }),
    );
  });
});
