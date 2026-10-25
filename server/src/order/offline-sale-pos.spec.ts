import { OrderFinancialStatus } from '@prisma/client';
import { GstCalculatorService } from '../gst/gst-calculator.service';
import { OrderService } from './order.service';

/**
 * The point of sale makes its bills through `createOfflineOrder` with a few
 * optional extras. Each must do exactly its job, and a sale without them must
 * be the order the offline form has always made.
 */

const ORG = 'org_1';
const USER = 'user_1';

function build() {
    const variants = [
        {
            id: 'var_shirt', title: 'M', sku: 'SH-M', price: 1000, gstRate: null, taxable: true,
            trackQuantity: true, continueSellingWhenOutOfStock: false, inventoryQuantity: 10,
            product: { id: 'prod_shirt', title: 'Linen shirt', vendor: 'Acme', vendorKey: null, gstRate: 5, channel: { currency: 'INR' } },
        },
        {
            // The hidden custom-item variant: untracked, nothing in stock.
            id: 'var_custom', title: 'GST 18%', sku: null, price: 0, gstRate: 18, taxable: true,
            trackQuantity: false, continueSellingWhenOutOfStock: true, inventoryQuantity: 0,
            product: { id: 'prod_custom', title: 'Custom item', vendor: null, vendorKey: null, gstRate: null, channel: { currency: 'INR' } },
        },
    ];
    const tx: any = {
        channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
        customer: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'cust_1', billingStateCode: null, gstin: null, defaultAddress: null }),
            update: jest.fn(),
        },
        productVariant: {
            findMany: jest.fn(async ({ where }: any) => variants.filter((v) => where.id.in.includes(v.id))),
            update: jest.fn().mockResolvedValue({ inventoryQuantity: 9 }),
        },
        organization: { findUnique: jest.fn().mockResolvedValue({ gstEnabled: false, currency: 'INR' }) },
        organizationGstin: { findMany: jest.fn().mockResolvedValue([]) },
        order: {
            findFirst: jest.fn().mockResolvedValue({ orderNumber: 1000 }),
            create: jest.fn(async ({ data }: any) => ({ id: 'order_1', name: '#M1001', customerId: data.customerId, financialStatus: data.financialStatus, lineItems: [] })),
            update: jest.fn(),
        },
        orderLineItem: { findMany: jest.fn().mockResolvedValue([{ fulfillmentStatus: null, quantity: 1, fulfilledQuantity: 0 }]) },
        warehouse: { findFirst: jest.fn(async ({ where }: any) => ({ id: where?.id ?? 'wh_default' })) },
        inventoryEvent: { create: jest.fn() },
        orderTimelineEvent: { create: jest.fn() },
    };
    const prisma: any = {
        $transaction: jest.fn(async (fn: any) => fn(tx)),
        organizationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        order: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const ledger = { isWarehousingEnabled: jest.fn().mockResolvedValue(true), applyMovement: jest.fn().mockResolvedValue({}) };
    const loyalty = { recomputeForCustomer: jest.fn().mockResolvedValue(undefined) };
    const commerceEvents = { order: jest.fn(), invoiceIssued: jest.fn() };
    const service = new OrderService(
        prisma,
        new GstCalculatorService(),
        { resolveLineGstRates: jest.fn(async (_o: string, _p: string, lines: any[]) => lines.map(() => 0)) } as any,
        { createForOrderTx: jest.fn() } as any,
        { enqueueOrderPush: jest.fn().mockResolvedValue(true) } as any,
        { findShopifyChannel: jest.fn().mockResolvedValue(null), recordFailure: jest.fn() } as any,
        {} as any,
        {} as any,
        {
            // Tracked everywhere: the custom item must still never be stocked.
            getProductSettings: jest.fn().mockResolvedValue({ trackQuantityGlobally: true, allowOversellGlobally: false }),
            getOrderSettings: jest.fn().mockResolvedValue({ autoSyncToShopify: false }),
        } as any,
        loyalty as any,
        ledger as any,
        { getRate: jest.fn() } as any,
        { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) } as any,
        commerceEvents as any,
    );
    return { service, tx, ledger, loyalty, commerceEvents };
}

const sale = (over: Record<string, unknown> = {}) =>
    ({
        customer: { firstName: 'Asha', phone: '+919800000001' },
        lineItems: [{ productVariantId: 'var_shirt', quantity: 1, unitPriceOverride: 1000 }],
        paymentMethod: 'CASH',
        generateInvoice: false,
        ...over,
    }) as any;

describe('createOfflineOrder — without the point-of-sale extras', () => {
    it('makes the order it always has', async () => {
        const { service, tx } = build();
        await service.createOfflineOrder(ORG, USER, sale());
        const data = tx.order.create.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('posSale');
        expect(data).not.toHaveProperty('posStaffId');
        expect(data.customerId).toBe('cust_1');
        expect(data.financialStatus).toBe(OrderFinancialStatus.PAID);
        // A workspace with stock locations: the sale left its default location,
        // which settles Shopify's stock itself, so the order never decrements it.
        expect(data.metadata).toEqual({ source: 'offline', paymentMethod: 'CASH', createdByUserId: USER, shopifyStockPushed: true });
        expect(tx.orderTimelineEvent.create.mock.calls[0][0].data.message).toBe('Offline order created (CASH)');
    });

    it('still refuses the same variant on two lines', async () => {
        const { service } = build();
        await expect(
            service.createOfflineOrder(ORG, USER, sale({ lineItems: [{ productVariantId: 'var_shirt', quantity: 1 }, { productVariantId: 'var_shirt', quantity: 2 }] })),
        ).rejects.toThrow(/Duplicate variant IDs/);
    });
});

describe('createOfflineOrder — a walk-in', () => {
    it('makes an order with no customer and refreshes no loyalty', async () => {
        const { service, tx, loyalty } = build();
        await service.createOfflineOrder(ORG, USER, sale({ customer: {} }), { walkIn: true });
        expect(tx.customer.findFirst).not.toHaveBeenCalled();
        expect(tx.customer.create).not.toHaveBeenCalled();
        expect(tx.order.create.mock.calls[0][0].data.customerId).toBeNull();
        expect(loyalty.recomputeForCustomer).not.toHaveBeenCalled();
    });
});

describe('createOfflineOrder — custom items', () => {
    const lines = [
        { productVariantId: 'var_shirt', quantity: 1, unitPriceOverride: 1000 },
        { productVariantId: 'var_custom', quantity: 1, unitPriceOverride: 250 },
        { productVariantId: 'var_custom', quantity: 2, unitPriceOverride: 40 },
    ];

    it('sells several on the one hidden variant, each under its own title', async () => {
        const { service, tx } = build();
        await service.createOfflineOrder(ORG, USER, sale({ lineItems: lines }), { customTitles: [null, 'Alteration', 'Loose buttons'] });
        const created = tx.order.create.mock.calls[0][0].data.lineItems.create;
        expect(created.map((l: any) => [l.variantId, l.title, l.variantTitle, l.sku, l.price])).toEqual([
            ['var_shirt', 'Linen shirt', 'M', 'SH-M', 1000],
            ['var_custom', 'Alteration', null, null, 250],
            ['var_custom', 'Loose buttons', null, null, 40],
        ]);
    });

    it('never stocks them, even when the org tracks every variant', async () => {
        const { service, ledger } = build();
        await service.createOfflineOrder(ORG, USER, sale({ lineItems: lines }), { customTitles: [null, 'Alteration', 'Loose buttons'] });
        expect(ledger.applyMovement).toHaveBeenCalledTimes(1);
        expect(ledger.applyMovement.mock.calls[0][0]).toMatchObject({ variantId: 'var_shirt' });
    });
});

describe('createOfflineOrder — a point-of-sale bill', () => {
    it('takes its payment status and metadata from the priced total, and stamps the bill', async () => {
        const { service, tx, commerceEvents } = build();
        const settle = jest.fn(() => ({
            financialStatus: OrderFinancialStatus.PARTIALLY_PAID,
            metadata: { paymentMethod: 'UPI', pos: { storeId: 'wh_1', roundOff: 0, clientSaleId: 'c1' } },
        }));
        await service.createOfflineOrder(ORG, USER, sale(), { pos: { staffId: 'st_1' }, settle });
        expect(settle).toHaveBeenCalledWith(1000);
        const data = tx.order.create.mock.calls[0][0].data;
        expect(data).toMatchObject({ posSale: true, posStaffId: 'st_1', financialStatus: OrderFinancialStatus.PARTIALLY_PAID });
        expect(data.metadata).toEqual({
            source: 'offline',
            paymentMethod: 'UPI',
            createdByUserId: USER,
            shopifyStockPushed: true,
            pos: { storeId: 'wh_1', roundOff: 0, clientSaleId: 'c1' },
        });
        expect(tx.orderTimelineEvent.create.mock.calls[0][0].data.message).toBe('Billed at the point of sale');
        // Not paid in full: no "paid" event.
        expect(commerceEvents.order).toHaveBeenCalledWith('order_1', ['created']);
    });

    it('runs its own writes inside the sale’s transaction, and a refusal there undoes the sale', async () => {
        const { service, tx, ledger } = build();
        const inTransaction = jest.fn(async (client: any) => {
            expect(client).toBe(tx);
        });
        await service.createOfflineOrder(ORG, USER, sale(), { inTransaction });
        expect(inTransaction).toHaveBeenCalledWith(tx, { id: 'order_1', customerId: 'cust_1' });

        const refused = build();
        await expect(
            refused.service.createOfflineOrder(ORG, USER, sale(), {
                inTransaction: async () => {
                    throw new Error('duplicate bill');
                },
            }),
        ).rejects.toThrow('duplicate bill');
        expect(refused.ledger.applyMovement).not.toHaveBeenCalled();
        expect(ledger.applyMovement).toHaveBeenCalled();
    });

    it('a settle that refuses the payments stops the sale before the order is written', async () => {
        const { service, tx } = build();
        await expect(
            service.createOfflineOrder(ORG, USER, sale(), {
                settle: () => {
                    throw new Error('The payments come to more than the bill.');
                },
            }),
        ).rejects.toThrow('more than the bill');
        expect(tx.order.create).not.toHaveBeenCalled();
    });
});
