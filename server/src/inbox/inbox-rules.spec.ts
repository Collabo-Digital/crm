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
