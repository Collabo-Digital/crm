import { UserRole } from '@prisma/client';
import { canAssign, canReply, seesAll, visibilityWhere } from './inbox-visibility';

const viewer = (role: UserRole, grants: string[] = []) => ({ userId: 'me', role, grants });

describe('inbox visibility', () => {
    it('shows owners, admins, managers and view-all agents everything', () => {
        for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]) {
            expect(visibilityWhere(viewer(role))).toEqual({});
        }
        expect(seesAll(viewer(UserRole.AGENT, ['chat.view_all']))).toBe(true);
    });

    it('limits an agent to their own conversations, plus the queue when granted', () => {
        expect(visibilityWhere(viewer(UserRole.AGENT, ['section.chat']))).toEqual({ OR: [{ assignedUserId: 'me' }] });
        expect(visibilityWhere(viewer(UserRole.AGENT, ['section.chat', 'chat.view_unassigned']))).toEqual({
            OR: [{ assignedUserId: 'me' }, { assignedUserId: null }],
        });
    });
});

describe('canAssign', () => {
    it('lets an agent take a free conversation or give back their own, nothing more', () => {
        const agent = viewer(UserRole.AGENT);
        expect(canAssign(agent, null, 'me')).toBe(true);
        expect(canAssign(agent, 'me', null)).toBe(true);
        expect(canAssign(agent, null, 'colleague')).toBe(false);
        expect(canAssign(agent, 'colleague', 'me')).toBe(false);
    });

    it('lets managers and chat.assign holders assign anyone, and viewers no one', () => {
        expect(canAssign(viewer(UserRole.MANAGER), 'a', 'b')).toBe(true);
        expect(canAssign(viewer(UserRole.AGENT, ['chat.assign']), 'a', 'b')).toBe(true);
        expect(canAssign(viewer(UserRole.VIEWER, ['chat.assign']), null, 'me')).toBe(false);
        expect(canReply(viewer(UserRole.VIEWER))).toBe(false);
        expect(canReply(viewer(UserRole.AGENT))).toBe(true);
    });
});
