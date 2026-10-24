import { ChannelPlatform, MessageStatus } from '@prisma/client';
import { MessageIngestService, StatusBeforeMessage } from './message-ingest.service';

const channel = { id: 'ch1', organizationId: 'org1', platform: ChannelPlatform.WHATSAPP, address: 'PN1' };
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

function build(found: unknown, inFlight: unknown) {
    const prisma = {
        message: {
            findFirst: jest.fn().mockResolvedValueOnce(found).mockResolvedValueOnce(inFlight),
            update: jest.fn().mockResolvedValue({}),
        },
    };
    const events = { publish: jest.fn() };
    const tracker = { onStatus: jest.fn() };
    const service = new MessageIngestService(prisma as never, {} as never, {} as never, {} as never, events as never, {} as never, tracker as never, {} as never, {} as never);
    return { service, prisma, events };
}

describe('MessageIngestService.applyStatus', () => {
    it('asks for the delivery to run again when a fresh status beats its send to the database', async () => {
        const { service } = build(null, { id: 'm1' });
        await expect(service.applyStatus(channel, 'wamid.1', { status: MessageStatus.FAILED, at: secondsAgo(3) })).rejects.toBeInstanceOf(StatusBeforeMessage);
    });

    it('drops a status for a message that is not ours once nothing is being sent', async () => {
        const { service } = build(null, null);
        expect(await service.applyStatus(channel, 'wamid.1', { status: MessageStatus.DELIVERED, at: secondsAgo(3) })).toBe(false);
    });

    it('drops an old status for an unknown message instead of retrying for ever', async () => {
        const { service, prisma } = build(null, { id: 'm1' });
        expect(await service.applyStatus(channel, 'wamid.1', { status: MessageStatus.DELIVERED, at: secondsAgo(180) })).toBe(false);
        expect(prisma.message.findFirst).toHaveBeenCalledTimes(1);
    });

    it('does not tell open inboxes about a pricing-only update', async () => {
        const { service, events, prisma } = build(
            { id: 'm1', status: MessageStatus.DELIVERED, conversationId: 'c1', contactId: null, organizationId: 'org1', sentAt: new Date() },
            null,
        );
        await service.applyStatus(channel, 'wamid.1', { status: MessageStatus.SENT, at: secondsAgo(3), pricing: { billable: true } });
        expect(prisma.message.update).toHaveBeenCalled();
        expect(events.publish).not.toHaveBeenCalled();
    });
});
