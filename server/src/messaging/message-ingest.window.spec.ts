import { ChannelPlatform, ConversationStatus } from '@prisma/client';
import { MessageIngestService } from './message-ingest.service';

const channel = { id: 'ch1', organizationId: 'org1', platform: ChannelPlatform.WHATSAPP, address: 'PN1' };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

function build(lastInboundAt: Date) {
    const existing = { id: 'cv1', status: ConversationStatus.OPEN, customerId: null, lastMessageAt: lastInboundAt, lastInboundAt, awaitingReplySince: lastInboundAt, firstResponseAt: null };
    const tx = {
        conversation: {
            findUnique: jest.fn(() => Promise.resolve(existing)),
            update: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...existing, ...data })),
        },
    };
    const service = new MessageIngestService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const inbound = async (at: Date) => {
        await service['upsertConversation'](tx as never, channel, 'ct1', null, { at, preview: 'hi', inbound: true, live: true, opensWindow: true, reopen: true });
    };
    const written = () => tx.conversation.update.mock.calls.map(([{ data }]) => data);
    return { inbound, written };
}

describe('MessageIngestService, the reply window', () => {
    it('is not moved back by an older message delivered late', async () => {
        const { inbound, written } = build(hoursAgo(1));
        await inbound(hoursAgo(20));
        expect(written()[0]).not.toHaveProperty('lastInboundAt');
    });

    it('opens again from a newer message', async () => {
        const { inbound, written } = build(hoursAgo(20));
        const at = hoursAgo(1);
        await inbound(at);
        expect(written()[0]).toMatchObject({ lastInboundAt: at });
    });
});
