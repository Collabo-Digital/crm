import { InboxRulesService, autoReplyKey } from './inbox-rules.service';
import { parseInboxSettings } from './inbox-settings.schema';

describe('InboxRulesService.pickAgent', () => {
    it('picks again when a parallel routing claimed the same agent first', async () => {
        const earlier = new Date('2026-10-25T09:00:00Z');
        const later = new Date('2026-10-25T09:30:00Z');
        const seen = new Date();
        const member = (userId: string, inboxLastAssignedAt: Date | null) => ({ userId, inboxStatus: 'ONLINE', inboxSeenAt: seen, inboxLastAssignedAt });
        const prisma = {
            organizationMember: {
                findMany: jest
                    .fn()
                    .mockResolvedValueOnce([member('a', earlier), member('b', later)])
                    // By the second read, someone else has just given "a" a conversation.
                    .mockResolvedValueOnce([member('a', new Date('2026-10-25T10:00:00Z')), member('b', later)]),
                updateMany: jest.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }),
            },
            conversation: { groupBy: jest.fn().mockResolvedValue([]) },
        };
        const service = new InboxRulesService(prisma as never, {} as never, {} as never, {} as never, {} as never);

        expect(await service.pickAgent('org1', null, 25)).toBe('b');
        expect(prisma.organizationMember.updateMany.mock.calls[0][0].where).toEqual({ organizationId: 'org1', userId: 'a', inboxLastAssignedAt: earlier });
        expect(prisma.organizationMember.updateMany.mock.calls[1][0].where).toEqual({ organizationId: 'org1', userId: 'b', inboxLastAssignedAt: later });
    });
});

describe('autoReplyKey', () => {
    it('gives every message of a burst the same key, and a new key once the cooldown has passed', () => {
        const t = Date.UTC(2026, 9, 25, 22, 10, 0);
        expect(autoReplyKey('away', 'ct1', 12, t)).toBe(autoReplyKey('away', 'ct1', 12, t + 400));
        expect(autoReplyKey('away', 'ct1', 12, t)).not.toBe(autoReplyKey('away', 'ct1', 12, t + 12 * 3600_000));
        expect(autoReplyKey('away', 'ct1', 12, t).startsWith('away:ct1:')).toBe(true);
    });
});

describe('InboxRulesService.autoClose', () => {
    it('closes open conversations quiet for longer than the setting, per organization', async () => {
        const now = new Date('2026-10-23T12:00:00Z');
        const updates: unknown[] = [];
        const published: string[] = [];
        const prisma = {
            organizationSettings: { findMany: jest.fn().mockResolvedValue([{ organizationId: 'org_a' }, { organizationId: 'org_off' }]) },
            conversation: {
                findMany: jest.fn().mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]),
                updateMany: jest.fn().mockImplementation((args) => {
                    updates.push(args);
                    return { count: 2 };
                }),
            },
        };
        const settings = {
            get: jest.fn().mockImplementation(async (orgId: string) => ({
                settings: parseInboxSettings({ autoClose: { enabled: orgId === 'org_a', afterHours: 48 } }),
                timeZone: 'UTC',
            })),
        };
        const events = { publish: jest.fn().mockImplementation((_org, e) => published.push(e.conversationId)) };
        const service = new InboxRulesService(prisma as never, settings as never, {} as never, {} as never, events as never);

        expect(await service.autoClose(now)).toBe(2);
        const cutoff = new Date('2026-10-21T12:00:00Z');
        expect(prisma.conversation.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.conversation.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org_a', status: 'OPEN', lastMessageAt: { lt: cutoff } });
        expect(updates[0]).toMatchObject({ where: { status: 'OPEN', lastMessageAt: { lt: cutoff } }, data: { status: 'CLOSED', closedAt: now } });
        expect(published).toEqual(['c1', 'c2']);
    });
});

describe('InboxRulesService.onEvent — reopened chats of departed members', () => {
    function build(assigneeStillHere: boolean) {
        const prisma = {
            conversation: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'c1', platform: 'WHATSAPP', channelId: 'ch1', contactId: 'ct1', customerId: null,
                    assignedUserId: 'gone', contact: { tags: [] }, customer: null,
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            organizationMember: { findFirst: jest.fn().mockResolvedValue(assigneeStillHere ? { userId: 'gone' } : null) },
        };
        const settings = { get: jest.fn().mockResolvedValue({ settings: parseInboxSettings({}), timeZone: 'Asia/Kolkata' }) };
        const service = new InboxRulesService(prisma as never, settings as never, {} as never, {} as never, { publish: jest.fn() } as never);
        const event = { id: 'e1', organizationId: 'org', channelId: 'ch1', contactId: 'ct1', eventType: 'whatsapp.message', text: 'hi', newConversation: true };
        return { service, prisma, event };
    }

    it('puts the chat back in the queue when its assignee has left the workspace', async () => {
        const { service, prisma, event } = build(false);

        await service.onEvent(event, { automated: true });

        expect(prisma.conversation.updateMany).toHaveBeenCalledWith({ where: { id: 'c1', assignedUserId: 'gone' }, data: { assignedUserId: null } });
    });

    it('leaves it with an assignee who is still a member', async () => {
        const { service, prisma, event } = build(true);

        await service.onEvent(event, { automated: true });

        expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });
});
