import { ChannelPlatform, ChannelStatus, OrderFinancialStatus, Prisma } from '@prisma/client';
import { ShopifyPushService, posSaleTransactions } from './shopify-push.service';
import { ORDER_CREATE_MUTATION } from './shopify-graphql.types';

/**
 * A point-of-sale bill reaches Shopify with the payments actually taken, from
 * the store it was sold at. An order without payment rows is pushed exactly
 * as before: one SALE for the total, at the primary location.
 */

const ORG = 'org_1';
const ORDER_ID = 'order_pos_1';
const d = (v: string | number) => new Prisma.Decimal(v);

function order(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        organizationId: ORG,
        name: '#M1050',
        currency: 'INR',
        note: null,
        totalPrice: d('1049.60'),
        financialStatus: OrderFinancialStatus.PAID,
        fulfillmentStatus: 'UNFULFILLED',
        metadata: { source: 'offline', paymentMethod: 'UPI' },
        externalId: 'manual_x',
        channel: { platform: ChannelPlatform.MANUAL },
        customer: null,
        lineItems: [
            { id: 'li_1', externalId: 'manual_li_1', title: 'Linen shirt', variantTitle: null, quantity: 1, price: d('1049.60'), totalDiscount: d('0'), channelTaxLines: null, variant: { externalId: '4777001' } },
        ],
        ...overrides,
    };
}

function build(o: ReturnType<typeof order>) {
    const channel = { id: 'ch_shopify', organizationId: ORG, platform: ChannelPlatform.SHOPIFY, status: ChannelStatus.CONNECTED, metadata: { shopifyLocationId: 111 } };
    const prisma = {
        channel: { findFirst: jest.fn().mockResolvedValue(channel), findUnique: jest.fn().mockResolvedValue(channel), update: jest.fn() },
        order: { findFirst: jest.fn().mockResolvedValue(o) },
        orderLineItem: { update: jest.fn((args) => args) },
        organization: { findUnique: jest.fn().mockResolvedValue({ currency: 'INR' }) },
        $transaction: jest.fn().mockResolvedValue(undefined),
        $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const graphql = {
        request: jest.fn(async (_auth: unknown, query: string, _vars?: unknown): Promise<any> =>
            query === ORDER_CREATE_MUTATION
                ? { orderCreate: { order: { id: 'gid://shopify/Order/9001', name: '#1201', lineItems: { nodes: [] } }, userErrors: [] } }
                : { order: { fulfillmentOrders: { nodes: [] } } },
        ),
    };
    const service = new ShopifyPushService(
        prisma as any,
        { getAccessToken: jest.fn().mockResolvedValue({ token: 't', shopDomain: 'acme.myshopify.com' }) } as any,
        graphql as any,
        {} as any,
        {} as any,
        { getRate: jest.fn().mockResolvedValue(1) } as any,
    );
    const sent = async () => {
        await service.pushOrder(ORDER_ID, ORG);
        return (graphql.request.mock.calls.find((c) => c[1] === ORDER_CREATE_MUTATION)![2] as any).order;
    };
    return { service, sent, prisma };
}

const payment = (method: string, amount: string) => ({ method, amount: d(amount) });

describe('ShopifyPushService.pushOrder — point-of-sale bills', () => {
    it('sends one SALE per payment, at the store’s Shopify location', async () => {
        const { sent } = build(order({
            posSale: true,
            dispatchWarehouse: { shopifyLocationId: '2222' },
            payments: [payment('UPI', '600'), payment('CARD', '450')],
            totalPrice: d('1049.60'),
        }));
        expect((await sent()).transactions).toEqual([
            { kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: '600.00', currencyCode: 'INR' } }, gateway: 'manual_upi', locationId: 'gid://shopify/Location/2222' },
            // ₹1,050 taken against a ₹1,049.60 total: Shopify is sent the total.
            { kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: '449.60', currencyCode: 'INR' } }, gateway: 'manual_card', locationId: 'gid://shopify/Location/2222' },
        ]);
    });

    it('does not mark a part-paid bill paid on Shopify', async () => {
        const { sent } = build(order({
            posSale: true,
            financialStatus: OrderFinancialStatus.PARTIALLY_PAID,
            payments: [payment('CASH', '500')],
        }));
        const txs = (await sent()).transactions;
        expect(txs).toEqual([
            { kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: '500.00', currencyCode: 'INR' } }, gateway: 'manual_cash' },
        ]);
    });

    it('sends no payment at all for a bill to be paid later', async () => {
        const { sent } = build(order({ posSale: true, financialStatus: OrderFinancialStatus.PENDING, payments: [] }));
        expect((await sent()).transactions).toEqual([]);
    });

    it('uses the store’s location to decide fulfilment, the primary when the store has none', async () => {
        const mapped = build(order({ posSale: true, fulfillmentStatus: 'FULFILLED', dispatchWarehouse: { shopifyLocationId: '2222' }, payments: [] }));
        const fulfil = jest.spyOn(mapped.service as any, 'fulfillEntireOrder').mockResolvedValue(undefined);
        const resolve = jest.spyOn(mapped.service as any, 'resolveLocationId');
        await mapped.service.pushOrder(ORDER_ID, ORG);
        expect(resolve).not.toHaveBeenCalled();
        expect(fulfil).toHaveBeenCalled();

        const unmapped = build(order({ posSale: true, dispatchWarehouse: { shopifyLocationId: null }, payments: [] }));
        const fallback = jest.spyOn(unmapped.service as any, 'resolveLocationId');
        await unmapped.service.pushOrder(ORDER_ID, ORG);
        expect(fallback).toHaveBeenCalled();
    });
});

describe('ShopifyPushService.pushOrder — orders without payment rows', () => {
    it('sends one SALE for the total with the order’s gateway and no location, as before', async () => {
        const { sent } = build(order({ payments: [], dispatchWarehouse: { shopifyLocationId: '2222' } }));
        expect((await sent()).transactions).toEqual([
            { kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount: '1049.6', currencyCode: 'INR' } }, gateway: 'manual_upi' },
        ]);
    });
});

describe('posSaleTransactions', () => {
    const bill = (total: string, status: OrderFinancialStatus, payments: Array<{ method: string; amount: Prisma.Decimal }>) => ({
        totalPrice: d(total),
        financialStatus: status,
        payments,
    });

    it('a paid bill rounded down: the last payment carries the paise', () => {
        expect(posSaleTransactions(bill('1049.40', OrderFinancialStatus.PAID, [payment('CASH', '1049')]), null)).toEqual([
            { amount: '1049.40', gateway: 'manual_cash', locationId: null },
        ]);
    });

    it('a part-paid bill whose payments reach the exact total still stays below it', () => {
        // Total ₹1,049.60, payable ₹1,050, ₹1,049.80 taken: only round-off is owed.
        const out = posSaleTransactions(bill('1049.60', OrderFinancialStatus.PARTIALLY_PAID, [payment('UPI', '1049.80')]), null);
        expect(out).toEqual([{ amount: '1049.59', gateway: 'manual_upi', locationId: null }]);
    });

    it('drops payments once the total is covered', () => {
        const out = posSaleTransactions(bill('100.00', OrderFinancialStatus.PAID, [payment('CARD', '100'), payment('CASH', '0.40')]), 7);
        expect(out).toEqual([{ amount: '100.00', gateway: 'manual_card', locationId: 'gid://shopify/Location/7' }]);
    });
});
