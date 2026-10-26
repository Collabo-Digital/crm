import { ChannelPlatform, ChannelStatus, MessageStatus } from '@prisma/client';
import { Priority } from '../../rate-limit/rate-limit.types';
import { MessagingSendService } from './messaging-send.service';

const conversation = {
    id: 'c1',
    organizationId: 'org1',
    channelId: 'ch1',
    contactId: 'ct1',
    customerId: null,
    platform: ChannelPlatform.WHATSAPP,
    lastInboundAt: null,
    firstResponseAt: null,
    contact: { externalId: '919800000000', blockedAt: null, optedOutAt: new Date('2026-10-01T00:00:00Z'), isGroup: false, whatsappGroup: null },
};

function build(prior: { id: string; status: MessageStatus; body: unknown } | null = null) {
    const prisma = {
        message: { findUnique: jest.fn().mockResolvedValue(prior), create: jest.fn().mockResolvedValue({ id: 'm-new' }) },
        conversation: { findFirst: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
        channelContact: { update: jest.fn() },
        messageTemplate: { findUnique: jest.fn().mockResolvedValue({ category: 'MARKETING' }) },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const access = {
        get: jest.fn().mockResolvedValue({
            platform: ChannelPlatform.WHATSAPP,
            status: ChannelStatus.CONNECTED,
            isEnabled: true,
            sendsPaused: false,
            onBusinessApp: false,
            address: 'PN1',
            wabaId: 'W1',
        }),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const events = { publish: jest.fn() };
    const service = new MessagingSendService(prisma as never, access as never, events as never, queue as never);
    return { service, prisma, queue };
}

describe('MessagingSendService.send', () => {
    it('queues delivery again for a retried key whose message is still waiting', async () => {
        const { service, queue } = build({ id: 'm1', status: MessageStatus.QUEUED, body: { humanAgentTag: false } });
        const outcome = await service.send({
            organizationId: 'org1',
            conversationId: 'c1',
            origin: 'agent',
            payload: { type: 'text', text: 'Hi' },
            idempotencyKey: 'inbox:u1:k1',
        });
        expect(outcome).toEqual({ ok: true, messageId: 'm1', duplicate: true });
        expect(queue.add).toHaveBeenCalledWith('deliver', { kind: 'deliver', messageId: 'm1', humanAgentTag: false }, expect.objectContaining({ jobId: 'deliver-m1', priority: Priority.INTERACTIVE }));
    });

    it('does not queue again a retried key whose message already went out', async () => {
        const { service, queue } = build({ id: 'm1', status: MessageStatus.SENT, body: {} });
        await service.send({ organizationId: 'org1', conversationId: 'c1', origin: 'agent', payload: { type: 'text', text: 'Hi' }, idempotencyKey: 'k' });
        expect(queue.add).not.toHaveBeenCalled();
    });

    it('applies the opt-out rule from the stored template category, not the one sent with the request', async () => {
        const { service, prisma } = build();
        const outcome = await service.send({
            organizationId: 'org1',
            conversationId: 'c1',
            origin: 'agent',
            payload: { type: 'template', name: 'diwali_sale', language: 'en', category: 'UTILITY' },
        });
        expect(outcome).toMatchObject({ ok: false, code: 'opted_out' });
        expect(prisma.messageTemplate.findUnique).toHaveBeenCalledWith({
            where: { wabaId_name_language: { wabaId: 'W1', name: 'diwali_sale', language: 'en' } },
            select: { category: true },
        });
        expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('treats an unknown template as marketing for a customer who opted out', async () => {
        const { service, prisma } = build();
        prisma.messageTemplate.findUnique.mockResolvedValueOnce(null);
        const outcome = await service.send({
            organizationId: 'org1',
            conversationId: 'c1',
            origin: 'agent',
            payload: { type: 'template', name: 'not_synced', language: 'en' },
        });
        expect(outcome).toMatchObject({ ok: false, code: 'opted_out' });
    });

    it('keeps a template’s header file on its row, with what it was sent as, and the order the message is about', async () => {
        const { service, prisma } = build();
        prisma.conversation.findFirst.mockResolvedValueOnce({ ...conversation, contact: { ...conversation.contact, optedOutAt: null } });
        prisma.messageTemplate.findUnique.mockResolvedValueOnce({ category: 'UTILITY' });
        const headerMedia = { storageKey: 'org1/bill.pdf', mime: 'application/pdf', kind: 'document' as const, filename: 'Bill-M1042.pdf' };
        const outcome = await service.send({
            organizationId: 'org1',
            conversationId: 'c1',
            origin: 'system',
            orderId: 'order_1',
            payload: { type: 'template', name: 'collabo_store_bill_v2', language: 'en', headerMedia, previewText: 'Hi Asha, your bill is ready.' },
        });
        expect(outcome).toEqual({ ok: true, messageId: 'm-new' });
        const data = prisma.message.create.mock.calls[0][0].data;
        expect(data.media).toEqual({ storageKey: 'org1/bill.pdf', mime: 'application/pdf', filename: 'Bill-M1042.pdf', kind: 'document' });
        expect(data).toMatchObject({ kind: 'TEMPLATE', orderId: 'order_1', text: 'Hi Asha, your bill is ready.', templateName: 'collabo_store_bill_v2' });
    });

    it('keeps no file for a template without a header file, and no order unless given', async () => {
        const { service, prisma } = build();
        prisma.conversation.findFirst.mockResolvedValueOnce({ ...conversation, contact: { ...conversation.contact, optedOutAt: null } });
        await service.send({ organizationId: 'org1', conversationId: 'c1', origin: 'agent', payload: { type: 'template', name: 'order_update', language: 'en' } });
        const data = prisma.message.create.mock.calls[0][0].data;
        expect(data.media).toBeUndefined();
        expect(data.orderId).toBeNull();
    });

    it('refuses a header file kept for another organization', async () => {
        const { service, prisma } = build();
        prisma.conversation.findFirst.mockResolvedValueOnce({ ...conversation, contact: { ...conversation.contact, optedOutAt: null } });
        await expect(service.send({
            organizationId: 'org1',
            conversationId: 'c1',
            origin: 'system',
            payload: { type: 'template', name: 'collabo_store_bill_v2', language: 'en', headerMedia: { storageKey: 'org2/bill.pdf', mime: 'application/pdf', kind: 'document' } },
        })).rejects.toThrow('Upload the file again before sending it.');
        expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('queues with the priority the caller gives', async () => {
        const { service, prisma, queue } = build();
        prisma.conversation.findFirst.mockResolvedValueOnce({ ...conversation, contact: { ...conversation.contact, optedOutAt: null } });
        prisma.messageTemplate.findUnique.mockResolvedValueOnce({ category: 'UTILITY' });
        await service.send({
            organizationId: 'org1',
            conversationId: 'c1',
            origin: 'broadcast',
            priority: Priority.BULK + 7,
            payload: { type: 'template', name: 'order_update', language: 'en' },
        });
        expect(queue.add).toHaveBeenCalledWith('deliver', expect.anything(), expect.objectContaining({ priority: Priority.BULK + 7 }));
        const stored = prisma.message.create.mock.calls[0][0].data.body.payload;
        expect(stored.category).toBe('UTILITY');
    });
});
