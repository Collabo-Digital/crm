import { ChannelPlatform } from '@prisma/client';
import { WhatsAppCallsService } from './whatsapp-calls.service';

const channel = { id: 'ch1', organizationId: 'org1', platform: ChannelPlatform.WHATSAPP, address: 'PN1' };
const user = { waId: '919800000000', userId: null, username: null, profileName: 'Spammer' };

function build(blockedAt: Date | null) {
    const tx = {
        conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', status: 'CLOSED' }), update: jest.fn().mockResolvedValue({ id: 'c1' }), create: jest.fn() },
    };
    const prisma = {
        whatsAppCall: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'call1', conversationId: 'c1', organizationId: 'org1' }) },
        $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const identity = { resolve: jest.fn().mockResolvedValue({ id: 'ct1', customerId: null, blockedAt }) };
    const metaGraph = { request: jest.fn().mockResolvedValue({ data: { success: true } }) };
    const access = { get: jest.fn().mockResolvedValue({ id: 'ch1', address: 'PN1', token: 't', scopes: [] }) };
    const events = { publish: jest.fn() };
    const service = new WhatsAppCallsService(prisma as never, metaGraph as never, access as never, identity as never, {} as never, events as never, {} as never);
    return { service, prisma, tx, metaGraph, events };
}

const connect = { id: 'wacid.1', event: 'connect', direction: 'USER_INITIATED', sdp: 'v=0', user, timestamp: new Date(), errors: [] };

describe('WhatsAppCallsService.onCall', () => {
    it('declines a blocked contact’s call without ringing the team or reopening the chat', async () => {
        const { service, prisma, tx, metaGraph, events } = build(new Date('2026-10-01T00:00:00Z'));
        await service.onCall(channel, connect as never);
        expect(metaGraph.request).toHaveBeenCalledWith(expect.objectContaining({ path: '/PN1/calls', body: { messaging_product: 'whatsapp', call_id: 'wacid.1', action: 'reject' } }));
        expect(prisma.whatsAppCall.create).not.toHaveBeenCalled();
        expect(tx.conversation.update).not.toHaveBeenCalled();
        expect(events.publish).not.toHaveBeenCalled();
    });

    it('rings for anyone else and reopens their closed chat', async () => {
        const { service, prisma, tx, metaGraph } = build(null);
        await service.onCall(channel, connect as never);
        expect(prisma.whatsAppCall.create).toHaveBeenCalled();
        expect(tx.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'OPEN' }) }));
        expect(metaGraph.request).not.toHaveBeenCalled();
    });
});
