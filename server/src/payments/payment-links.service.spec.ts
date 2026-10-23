import { createHmac } from 'node:crypto';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaymentLinksService } from './payment-links.service';

const ORG = 'org_1';

function link(over: Record<string, unknown> = {}) {
    return {
        id: 'pl_1', organizationId: ORG, accountId: 'acc_1', provider: 'RAZORPAY', externalId: 'plink_1', shortUrl: 'https://rzp.io/rzp/x',
        referenceId: 'cl_x', amount: new Prisma.Decimal('2398.00'), amountPaid: new Prisma.Decimal(0), currency: 'INR', description: 'Order #1801',
        status: 'CREATED', orderId: 'order_1', draftOrderId: null, customerId: 'cust_1', contactId: 'contact_1', conversationId: 'conv_1',
        automationRunId: null, createdById: null, tagOnPaid: 'cod-to-prepaid', expiresAt: new Date(Date.now() + 86_400_000), paidAt: null,
        paymentId: null, paymentMethod: null, followUpError: null, createdAt: new Date(), updatedAt: new Date(),
        ...over,
    };
}

function build(opts: { link?: ReturnType<typeof link> | null; claim?: number; financialStatus?: string } = {}) {
    const updates: any[] = [];
    const prisma = {
        paymentAccount: {
            findUnique: jest.fn(async ({ where }: any) => (where.webhookToken === 'tok_1' ? { id: 'acc_1', organizationId: ORG, credentials: 'c', disconnectedAt: null } : null)),
            update: jest.fn(async () => ({})),
        },
        paymentLink: {
            findUnique: jest.fn(async ({ where }: any) => (where.accountId_externalId?.accountId === 'acc_1' ? opts.link ?? null : null)),
            updateMany: jest.fn(async (args: any) => {
                updates.push(args);
                return { count: args.data.status === 'PAID' ? opts.claim ?? 1 : 1 };
            }),
            update: jest.fn(async (args: any) => {
                updates.push(args);
                return {};
            }),
        },
        order: { findUnique: jest.fn(async () => ({ financialStatus: opts.financialStatus ?? 'PENDING' })) },
    };
    const accounts = { webhookSecret: jest.fn(() => 'whsec'), keys: jest.fn(() => ({ keyId: 'rzp_test_x', keySecret: 's' })) };
    const orders = { markPaid: jest.fn(async () => ({})) };
    const store = { actorFor: jest.fn(async () => 'u_owner'), tagOrder: jest.fn(async () => ({ tags: [] })) };
    const events = { paymentReceived: jest.fn(async () => undefined) };
    const drafts = { complete: jest.fn() };
    const service = new PaymentLinksService(prisma as any, accounts as any, {} as any, orders as any, drafts as any, store as any, events as any);
    return { service, prisma, orders, store, events, updates };
}

const paidBody = (amountPaid = 239800, id = 'plink_1') =>
    Buffer.from(JSON.stringify({
        event: 'payment_link.paid',
        payload: {
            payment_link: { entity: { id, status: 'paid', amount: 239800, amount_paid: amountPaid, currency: 'INR', reference_id: 'cl_x' } },
            payment: { entity: { id: 'pay_1', method: 'upi', status: 'captured', amount: amountPaid } },
        },
    }));
const sign = (body: Buffer, secret = 'whsec') => createHmac('sha256', secret).update(body).digest('hex');

describe('PaymentLinksService webhook', () => {
    it('marks the order paid, tags it and raises "payment received" when a link is paid', async () => {
        const { service, orders, store, events } = build({ link: link() });
        const body = paidBody();
        await expect(service.webhook('tok_1', body, sign(body))).resolves.toEqual({ received: true });
        await service.idle();
        expect(orders.markPaid).toHaveBeenCalledWith('order_1', ORG, 'u_owner', expect.stringContaining('pay_1'));
        expect(store.tagOrder).toHaveBeenCalledWith(ORG, 'order_1', 'cod-to-prepaid', 'u_owner');
        expect(events.paymentReceived).toHaveBeenCalledWith(expect.objectContaining({ linkId: 'pl_1', orderId: 'order_1', contactId: 'contact_1' }));
    });

    it('does the follow-up once: a redelivered webhook that loses the claim changes nothing', async () => {
        const { service, orders, events } = build({ link: link(), claim: 0 });
        const body = paidBody();
        await service.webhook('tok_1', body, sign(body));
        await service.idle();
        expect(orders.markPaid).not.toHaveBeenCalled();
        expect(events.paymentReceived).not.toHaveBeenCalled();
    });

    it('never marks the order paid when the amount paid differs from the link', async () => {
        const { service, orders, updates } = build({ link: link() });
        const body = paidBody(100);
        await service.webhook('tok_1', body, sign(body));
        expect(orders.markPaid).not.toHaveBeenCalled();
        expect(updates.at(-1).data.followUpError).toMatch(/not marked paid/);
    });

    it('does not mark an order paid twice when it already is', async () => {
        const { service, orders, events } = build({ link: link(), financialStatus: 'PAID' });
        const body = paidBody();
        await service.webhook('tok_1', body, sign(body));
        await service.idle();
        expect(orders.markPaid).not.toHaveBeenCalled();
        expect(events.paymentReceived).toHaveBeenCalled();
    });

    it('keeps the payment and records why the order could not follow', async () => {
        const { service, orders, events, updates } = build({ link: link() });
        orders.markPaid.mockRejectedValueOnce(new Error('Shopify said no'));
        const body = paidBody();
        await service.webhook('tok_1', body, sign(body));
        await service.idle();
        expect(updates.some((u) => u.data?.followUpError === 'Shopify said no')).toBe(true);
        expect(events.paymentReceived).toHaveBeenCalled();
    });

    it('refuses a body not signed with this account’s secret', async () => {
        const { service, orders } = build({ link: link() });
        const body = paidBody();
        await expect(service.webhook('tok_1', body, sign(body, 'someone-else'))).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(service.webhook('tok_1', body, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(orders.markPaid).not.toHaveBeenCalled();
    });

    it('does not know a token it never issued', async () => {
        const { service } = build({ link: link() });
        const body = paidBody();
        await expect(service.webhook('tok_other', body, sign(body))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ignores links that are not this account’s', async () => {
        const { service, orders, prisma } = build({ link: null });
        const body = paidBody(239800, 'plink_elsewhere');
        await expect(service.webhook('tok_1', body, sign(body))).resolves.toEqual({ received: true });
        expect(prisma.paymentLink.findUnique).toHaveBeenCalledWith({ where: { accountId_externalId: { accountId: 'acc_1', externalId: 'plink_elsewhere' } } });
        expect(orders.markPaid).not.toHaveBeenCalled();
    });

    it('never moves a paid link back to expired or cancelled', async () => {
        const { service, updates } = build({ link: link({ status: 'PAID' }) });
        const body = Buffer.from(JSON.stringify({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: 'plink_1', status: 'expired', amount: 239800, amount_paid: 0, currency: 'INR' } } } }));
        await service.webhook('tok_1', body, sign(body));
        expect(updates).toHaveLength(0);
    });
});
