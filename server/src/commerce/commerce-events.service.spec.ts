import { Prisma } from '@prisma/client';
import { CommerceEventsService } from './commerce-events.service';
import { readStoreLinkToken, storeLinkKey } from './store-links';

type Row = Record<string, any>;

function harness(told?: () => Promise<string[] | void>) {
    const events: Row[] = [];
    const listened: string[][] = [];
    const prisma = {
        order: {
            findUnique: jest.fn(async () => ({
                id: 'cm3order0000000000000001',
                organizationId: 'o',
                customerId: 'cust1',
                name: '#1042',
                totalPrice: new Prisma.Decimal('2499'),
                currency: 'INR',
                financialStatus: 'PAID',
                fulfillmentStatus: 'FULFILLED',
                paymentGateways: ['razorpay'],
                shippingAddress: { phone: '+91 98111 00021', country_code: 'IN' },
                billingAddress: null,
                customer: { id: 'cust1', phone: null },
                lineItems: [{ title: 'Linen shirt', quantity: 1 }],
                fulfillments: [],
            })),
        },
        automationTrigger: { findMany: jest.fn(async () => [{ channel: { id: 'ch_wa', platform: 'WHATSAPP' } }]) },
        channelContact: { findFirst: jest.fn(async () => ({ id: 'c1', externalId: '919811100021', customerId: 'cust1' })) },
        customer: { findFirst: jest.fn(async () => null) },
        automationEvent: {
            create: jest.fn(async ({ data }: Row) => {
                events.push(data);
                return { id: `e${events.length}` };
            }),
        },
    };
    const jobs = { event: jest.fn() };
    const config = { get: (key: string) => (key === 'encryptionKey' ? 'enc-secret' : undefined) };
    const service = new CommerceEventsService(prisma as never, jobs as never, config as never);
    // As WhatsApp Pay's listener does: it returns what it put on the customer's order page.
    service.onOrder(async (_id, kinds) => {
        listened.push(kinds);
        return (await told?.()) as never;
    });
    return { service, events, jobs, prisma, listened };
}

const key = storeLinkKey('enc-secret');

describe('CommerceEventsService — the pack’s store events', () => {
    it('raises out for delivery once per order, with a signed link to the order’s page', async () => {
        const h = harness();
        await h.service.order('cm3order0000000000000001', ['out_for_delivery']);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]).toMatchObject({ eventType: 'crm.order.out_for_delivery', externalId: 'cm3order0000000000000001:out_for_delivery', orderId: 'cm3order0000000000000001' });
        const vars = h.events[0].payload.raw.vars;
        expect(readStoreLinkToken(key, 'order', vars['order.track_path'])).toBe('cm3order0000000000000001');
        // The raw tracking link stays as it was.
        expect(vars['order.tracking_url']).toBe('');
        expect(h.jobs.event).toHaveBeenCalledWith('e1');
    });

    it('raises one event per refund, with its amount', async () => {
        const h = harness();
        await h.service.refunded('cm3order0000000000000001', { id: 'rf_row_1', amount: '500', currency: 'INR' });
        expect(h.events[0]).toMatchObject({ eventType: 'crm.order.refunded', externalId: 'rf_row_1:refunded', orderId: 'cm3order0000000000000001', customerId: 'cust1' });
        expect(h.events[0].payload.raw).toMatchObject({ refundId: 'rf_row_1', vars: expect.objectContaining({ 'refund.amount': '₹500.00', 'order.name': '#1042' }) });
    });

    it('gives an abandoned checkout a signed cart link and names its checkout', async () => {
        const h = harness();
        await h.service.checkoutAbandoned({
            id: 'cm3checkout00000000000001',
            organizationId: 'o',
            phone: '+919811100026',
            recoveryUrl: 'https://shop.example/7001/checkouts/ctok/recover?key=k',
            total: new Prisma.Decimal('1199'),
            currency: 'INR',
            items: [{ title: 'Linen shirt', quantity: 1 }],
            firstName: 'Ritu',
            customerExternalId: null,
            channelId: 'ch_shop',
            updatedAt: new Date('2026-10-26T10:00:00Z'),
        });
        const raw = h.events[0].payload.raw;
        expect(raw.checkoutId).toBe('cm3checkout00000000000001');
        expect(raw.quietSince).toBe('2026-10-26T10:00:00.000Z');
        expect(readStoreLinkToken(key, 'cart', raw.vars['checkout.cart_path'])).toBe('cm3checkout00000000000001');
        expect(raw.vars['checkout.url']).toBe('https://shop.example/7001/checkouts/ctok/recover?key=k');
    });
});

describe('CommerceEventsService — WhatsApp Pay’s own notices', () => {
    const flags = (h: ReturnType<typeof harness>) => Object.fromEntries(h.events.map((e) => [e.eventType, e.payload.raw.whatsAppPayNotice === true]));

    it('marks the events WhatsApp Pay told the customer of itself, and only those', async () => {
        const h = harness(async () => ['fulfilled', 'delivered']);
        await h.service.order('cm3order0000000000000001', ['fulfilled', 'out_for_delivery', 'delivered']);
        expect(h.listened).toEqual([['fulfilled', 'out_for_delivery', 'delivered']]);
        expect(flags(h)).toEqual({ 'crm.order.fulfilled': true, 'crm.order.out_for_delivery': false, 'crm.order.delivered': true });
    });

    it('marks nothing when WhatsApp Pay told nothing (its window closed, or not its order), or its listener failed', async () => {
        const quiet = harness(async () => []);
        await quiet.service.order('cm3order0000000000000001', ['fulfilled', 'cancelled']);
        expect(flags(quiet)).toEqual({ 'crm.order.fulfilled': false, 'crm.order.cancelled': false });
        const silent = harness(async () => undefined);
        await silent.service.order('cm3order0000000000000001', ['delivered']);
        expect(flags(silent)).toEqual({ 'crm.order.delivered': false });
        const failed = harness(async () => {
            throw new Error('Graph down');
        });
        await failed.service.order('cm3order0000000000000001', ['cancelled']);
        expect(flags(failed)).toEqual({ 'crm.order.cancelled': false });
    });
});
