import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { conversationWhere, parseFilters } from './inbox-filters';
import { presenceOf } from './inbox-team.service';

const now = new Date('2026-10-23T12:00:00Z');
const agent = { userId: 'me', role: UserRole.AGENT, grants: [], teamIds: ['t1'] };
const owner = { userId: 'me', role: UserRole.OWNER, grants: [], teamIds: [] };

describe('parseFilters', () => {
    it('accepts the list filters and rejects anything else', () => {
        expect(parseFilters({ view: 'unassigned', teamId: 't1', comments: true })).toEqual({
            view: 'unassigned',
            teamId: 't1',
            comments: true,
        });
        expect(() => parseFilters({ view: 'everything' })).toThrow(BadRequestException);
        expect(() => parseFilters({ orderBy: 'id' })).toThrow(BadRequestException);
    });
});

describe('conversationWhere', () => {
    it('keeps a saved view inside the member\'s own visibility', () => {
        const where = conversationWhere('org', agent, { view: 'unassigned' }, now);
        expect(where.AND).toEqual(
            expect.arrayContaining([
                { organizationId: 'org' },
                { OR: [{ assignedUserId: 'me' }, { assignedUserId: null, teamId: { in: ['t1'] } }] },
                { assignedUserId: null },
            ]),
        );
    });

    it('filters by team, the no-team queue, comments and unread', () => {
        const and = (f: Parameters<typeof conversationWhere>[2]) => conversationWhere('org', owner, f, now).AND;
        expect(and({ teamId: 't1' })).toContainEqual({ teamId: 't1' });
        expect(and({ teamId: 'none' })).toContainEqual({ teamId: null });
        expect(and({ comments: true })).toContainEqual({ messages: { some: { kind: 'COMMENT' } } });
        expect(and({ unread: true })).toContainEqual({ unreadCount: { gt: 0 } });
        expect(and({ status: 'closed' })).toContainEqual({ status: 'CLOSED' });
    });
});

describe('presenceOf', () => {
    it('is offline without a recent heartbeat, else what the member chose', () => {
        const seen = new Date(now.getTime() - 30_000);
        expect(presenceOf('ONLINE', seen, now)).toBe('online');
        expect(presenceOf('AWAY', seen, now)).toBe('away');
        expect(presenceOf('ONLINE', new Date(now.getTime() - 5 * 60_000), now)).toBe('offline');
        expect(presenceOf('ONLINE', null, now)).toBe('offline');
    });
});
