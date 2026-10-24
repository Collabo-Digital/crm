import { InboxRulesService } from './inbox-rules.service';
import { parseInboxSettings } from './inbox-settings.schema';

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
