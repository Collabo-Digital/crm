import { NotFoundException } from '@nestjs/common';
import { storeLinkKey, storeLinkToken } from '../../../commerce/store-links';
import { PublicLinksService } from './public-links.service';

/**
 * The order and cart links of the pack's messages: the signed token is the
 * only key, a changed one finds nothing, and no customer data is given out.
 */

const SECRET = 'enc-key-for-tests';
const key = storeLinkKey(SECRET);
const ORDER = 'cm3x8k2p40000qz7w1rbt9e4d';
const CHECKOUT = 'cm3x8k2p40000qz7w1rbt9e4e';
const org = { name: 'Acme Org', settings: { storeProfileSettings: { storeName: 'Acme Store' } } };

function build(order: Record<string, unknown> | null, checkout: Record<string, unknown> | null = null) {
    const prisma = {
        order: { findFirst: jest.fn(async () => order) },
        checkout: { findUnique: jest.fn(async () => checkout) },
    };
    const config = { get: (k: string) => (k === 'encryptionKey' ? SECRET : 'jwt-secret') };
    return { service: new PublicLinksService(prisma as any, config as any), prisma };
}

const anOrder = (patch: Record<string, unknown> = {}) => ({
    name: '#1042',
    cancelledAt: null,
    fulfillmentStatus: 'UNFULFILLED',
    organization: org,
    fulfillments: [],
    ...patch,
});
const shipment = (patch: Record<string, unknown> = {}) => ({
    status: 'success', trackingNumber: 'AWB77', trackingUrl: 'https://track.example/AWB77', trackingCompany: 'Delhivery', deliveredAt: null, outForDeliveryAt: null, ...patch,
});

describe('the order link', () => {
    it('gives the store’s name and the order’s status and tracking, and nothing about the customer', async () => {
        const { service, prisma } = build(anOrder({ fulfillments: [shipment()] }));
        const link = await service.order(storeLinkToken(key, 'order', ORDER));
        expect(link).toEqual({
            storeName: 'Acme Store',
            order: { name: '#1042', status: 'shipped', carrier: 'Delhivery', trackingNumber: 'AWB77', trackingUrl: 'https://track.example/AWB77' },
        });
        expect((prisma.order.findFirst.mock.calls[0] as any)[0].where).toEqual({ id: ORDER, deletedAt: null });
        expect(JSON.stringify((prisma.order.findFirst.mock.calls[0] as any)[0].select)).not.toMatch(/customer|phone|address|email/i);
    });

    it.each([
        ['confirmed', anOrder()],
        ['shipped', anOrder({ fulfillmentStatus: 'FULFILLED' })],
        ['out_for_delivery', anOrder({ fulfillments: [shipment({ outForDeliveryAt: new Date() })] })],
        ['delivered', anOrder({ fulfillments: [shipment({ outForDeliveryAt: new Date(), deliveredAt: new Date() })] })],
        ['delivered', anOrder({ fulfillments: [shipment({ status: 'delivered' })] })],
        ['cancelled', anOrder({ cancelledAt: new Date(), fulfillments: [shipment()] })],
        ['confirmed', anOrder({ fulfillments: [shipment({ status: 'cancelled' })] })],
    ])('reads %s', async (status, order) => {
        const { service } = build(order);
        expect((await service.order(storeLinkToken(key, 'order', ORDER))).order.status).toBe(status);
    });

    it('falls back to the organization’s name, and gives no tracking address that is not a web page', async () => {
        const { service } = build(anOrder({
            organization: { name: 'Acme Org', settings: null },
            fulfillments: [shipment({ trackingUrl: 'javascript:alert(1)', trackingCompany: '', trackingNumber: '' })],
        }));
        const link = await service.order(storeLinkToken(key, 'order', ORDER));
        expect(link).toEqual({ storeName: 'Acme Org', order: { name: '#1042', status: 'shipped', carrier: null, trackingNumber: null, trackingUrl: null } });
    });

    it.each([
        ['a changed token', `${storeLinkToken(key, 'order', ORDER).slice(0, -1)}x`],
        ['a cart token', storeLinkToken(key, 'cart', ORDER)],
        ['a token made with another key', storeLinkToken(storeLinkKey('other'), 'order', ORDER)],
        ['a bare id', ORDER],
    ])('refuses %s without looking anything up', async (_label, token) => {
        const { service, prisma } = build(anOrder());
        await expect(service.order(token)).rejects.toThrow(new NotFoundException("This link isn't valid."));
        expect(prisma.order.findFirst).not.toHaveBeenCalled();
    });

    it('is not valid for an order that is gone', async () => {
        const { service } = build(null);
        await expect(service.order(storeLinkToken(key, 'order', ORDER))).rejects.toThrow("This link isn't valid.");
    });
});

describe('the cart link', () => {
    it('gives the checkout’s recovery address when it is https, and whether the order was placed', async () => {
        const { service } = build(null, { recoveryUrl: 'https://acme.example/7001/checkouts/ctok/recover?key=k', completedAt: null, organization: org });
        expect(await service.cart(storeLinkToken(key, 'cart', CHECKOUT))).toEqual({
            storeName: 'Acme Store',
            url: 'https://acme.example/7001/checkouts/ctok/recover?key=k',
            completed: false,
        });
    });

    it('gives no address that is not https, and says when the order was placed', async () => {
        const { service } = build(null, { recoveryUrl: 'http://acme.example/recover', completedAt: new Date(), organization: org });
        expect(await service.cart(storeLinkToken(key, 'cart', CHECKOUT))).toEqual({ storeName: 'Acme Store', url: null, completed: true });
    });

    it('refuses an order token, a changed one, or a checkout that is gone', async () => {
        const { service } = build(null, null);
        await expect(service.cart(storeLinkToken(key, 'order', CHECKOUT))).rejects.toThrow("This link isn't valid.");
        await expect(service.cart(`${CHECKOUT}.xx`)).rejects.toThrow("This link isn't valid.");
        await expect(service.cart(storeLinkToken(key, 'cart', CHECKOUT))).rejects.toThrow("This link isn't valid.");
    });
});
