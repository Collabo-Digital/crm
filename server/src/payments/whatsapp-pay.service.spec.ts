import { WhatsAppPayService } from './whatsapp-pay.service';

const ORG = 'org_1';

function request(over: Record<string, unknown> = {}) {
    return {
        id: 'wp_old', organizationId: ORG, provider: 'WHATSAPP_PAY', status: 'CREATED', orderId: 'order_1', draftOrderId: null,
        conversationId: 'conv_1', referenceId: 'cw_old', channelId: 'ch_1', paymentConfiguration: 'cfg', expiresAt: new Date(Date.now() + 3_600_000),
        ...over,
    };
}

function build(open: Array<ReturnType<typeof request>> = []) {
    const prisma = {
        paymentLink: {
            findMany: jest.fn(async () => open),
            updateMany: jest.fn(async () => ({ count: 1 })),
        },
    };
    const sender = { send: jest.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, messageId: 'wamid' })) };
    const links = { onClose: jest.fn(), toView: jest.fn() };
    const events = { onOrder: jest.fn() };
    const service = new WhatsAppPayService(prisma as any, {} as any, {} as any, sender as any, links as any, events as any);
    return { service, prisma, sender, links };
}

describe('WhatsAppPayService closing other bills', () => {
    it('tells WhatsApp a replaced bill is cancelled, so it cannot still be paid', async () => {
        const { service, prisma, sender } = build([request()]);

        await (service as any).closeRequests({ id: 'pl_new', organizationId: ORG, orderId: 'order_1', draftOrderId: null }, 'replaced');

        expect(prisma.paymentLink.findMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ provider: 'WHATSAPP_PAY', status: 'CREATED', id: { not: 'pl_new' }, orderId: 'order_1' }),
        });
        expect(prisma.paymentLink.updateMany).toHaveBeenCalledWith({ where: { id: 'wp_old', status: 'CREATED' }, data: { status: 'CANCELLED' } });
        expect(sender.send).toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: 'conv_1',
                payload: expect.objectContaining({ type: 'order_status', referenceId: 'cw_old', status: 'canceled' }),
            }),
        );
    });

    it('registers with payment links so a paid link closes open bills', () => {
        const { service, links } = build();
        service.onModuleInit();
        expect(links.onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps asking Meta about a closed bill until it expires', async () => {
        const { service, prisma } = build([]);

        await service.sweep();

        const where = (prisma.paymentLink.findMany.mock.calls[0] as any)[0].where;
        expect(where.OR).toEqual([
            { status: 'CREATED' },
            { status: 'CANCELLED', expiresAt: { gt: expect.any(Date) } },
        ]);
    });
});

describe('WhatsAppPayService updating the order page', () => {
    const statuses = (sender: ReturnType<typeof build>['sender']) => sender.send.mock.calls.map((c) => ((c as any)[0].payload as { status: string }).status);

    it('says shipped and delivered for an order paid by WhatsApp Pay, and returns what it told', async () => {
        const { service, sender } = build([request({ status: 'PAID' })]);
        await expect((service as any).orderChanged('order_1', ['fulfilled', 'out_for_delivery', 'delivered'])).resolves.toEqual(['fulfilled', 'delivered']);
        expect(statuses(sender)).toEqual(['shipped', 'completed']);
    });

    it('returns nothing it could not tell: window closed, no chat, or a paid order cancelled', async () => {
        const closed = build([request({ status: 'PAID' })]);
        closed.sender.send.mockResolvedValue({ ok: false, code: 'window_closed', message: 'The 24-hour reply window closed.' });
        await expect((closed.service as any).orderChanged('order_1', ['fulfilled'])).resolves.toEqual([]);
        const noChat = build([request({ status: 'PAID', conversationId: null })]);
        await expect((noChat.service as any).orderChanged('order_1', ['delivered'])).resolves.toEqual([]);
        expect(noChat.sender.send).not.toHaveBeenCalled();
        const paidCancel = build([request({ status: 'PAID' })]);
        await expect((paidCancel.service as any).orderChanged('order_1', ['cancelled'])).resolves.toEqual([]);
        expect(paidCancel.sender.send).not.toHaveBeenCalled();
    });

    it('closes an unpaid request on a cancelled order, and returns the cancellation it told', async () => {
        const { service, sender, prisma } = build([request()]);
        await expect((service as any).orderChanged('order_1', ['cancelled'])).resolves.toEqual(['cancelled']);
        expect(statuses(sender)).toEqual(['canceled']);
        expect(prisma.paymentLink.updateMany).toHaveBeenCalledWith({ where: { id: 'wp_old', status: 'CREATED' }, data: { status: 'CANCELLED' } });
    });
});
