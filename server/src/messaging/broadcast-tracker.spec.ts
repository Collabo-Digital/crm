import { BroadcastRecipientStatus, MessageKind, MessageStatus } from '@prisma/client';
import { BroadcastTracker } from './broadcast-tracker';

describe('broadcast replies', () => {
    const reply = { contactId: 'c_1', at: new Date('2026-10-22T10:00:00Z'), replyToExternalId: null, kind: MessageKind.TEXT };

    function tracker(latest: { id: string; repliedAt: Date | null } | null) {
        const prisma = { broadcastRecipient: { findFirst: jest.fn(async () => latest), update: jest.fn() } };
        return { prisma, tracker: new BroadcastTracker(prisma as any) };
    }

    it('credit the latest broadcast in the window', async () => {
        const { prisma, tracker: t } = tracker({ id: 'r_tuesday', repliedAt: null });
        await t.onInbound(reply);
        // The latest one, whether or not it already has a reply.
        expect((prisma.broadcastRecipient.findFirst.mock.calls[0] as any[])[0].where.repliedAt).toBeUndefined();
        expect(prisma.broadcastRecipient.update).toHaveBeenCalledWith({ where: { id: 'r_tuesday' }, data: { repliedAt: reply.at } });
    });

    it('credit nothing once the latest broadcast has its reply, rather than an older one', async () => {
        const { prisma, tracker: t } = tracker({ id: 'r_tuesday', repliedAt: new Date('2026-10-21T10:00:00Z') });
        await t.onInbound(reply);
        expect(prisma.broadcastRecipient.update).not.toHaveBeenCalled();
    });
});

describe('broadcast statuses', () => {
    it('count a played voice message as read', async () => {
        const prisma = { broadcastRecipient: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
        const at = new Date('2026-10-22T10:00:00Z');
        await new BroadcastTracker(prisma as any).onStatus('m1', MessageStatus.PLAYED, at);
        expect(prisma.broadcastRecipient.updateMany).toHaveBeenCalledWith({
            where: { messageId: 'm1', status: { in: [BroadcastRecipientStatus.PENDING, BroadcastRecipientStatus.QUEUED, BroadcastRecipientStatus.SENT, BroadcastRecipientStatus.DELIVERED] } },
            data: { status: BroadcastRecipientStatus.READ, readAt: at },
        });
        expect(prisma.broadcastRecipient.updateMany).toHaveBeenCalledWith({ where: { messageId: 'm1', deliveredAt: null }, data: { deliveredAt: at } });
    });
});
