import { Prisma, UserRole } from '@prisma/client';
import { IMPLICIT_ALL_ROLES } from '../auth/permissions';

export interface InboxViewer {
    userId: string;
    role: UserRole;
    /** OrganizationMember grants (empty for roles that hold everything). */
    grants: readonly string[];
    /** Inbox teams the member belongs to. */
    teamIds: readonly string[];
}

/** Owners, admins and managers see every conversation; others need `chat.view_all`. */
export function seesAll(viewer: InboxViewer): boolean {
    return IMPLICIT_ALL_ROLES.includes(viewer.role) || viewer.grants.includes('chat.view_all');
}

export function seesUnassigned(viewer: InboxViewer): boolean {
    return seesAll(viewer) || viewer.grants.includes('chat.view_unassigned');
}

/**
 * The conversations a member may open: everything, or the ones assigned to
 * them plus the unassigned queue — all of it with `chat.view_unassigned`,
 * otherwise only the part queued for one of their teams.
 */
export function visibilityWhere(viewer: InboxViewer): Prisma.ConversationWhereInput {
    if (seesAll(viewer)) return {};
    const queue: Prisma.ConversationWhereInput[] = seesUnassigned(viewer)
        ? [{ assignedUserId: null }]
        : viewer.teamIds.length
            ? [{ assignedUserId: null, teamId: { in: [...viewer.teamIds] } }]
            : [];
    return { OR: [{ assignedUserId: viewer.userId }, ...queue] };
}

/**
 * May this member move the conversation from `current` to `next` assignee?
 * Taking an unassigned conversation, or giving back one's own, needs no grant;
 * handing it to someone else (or taking it from them) needs `chat.assign`.
 */
export function canAssign(viewer: InboxViewer, current: string | null, next: string | null): boolean {
    if (viewer.role === UserRole.VIEWER) return false;
    if (canAssignOthers(viewer)) return true;
    const takingFree = current === null && next === viewer.userId;
    const releasingOwn = current === viewer.userId && next === null;
    return takingFree || releasingOwn;
}

/** Hand conversations to anyone and move them between teams. */
export function canAssignOthers(viewer: InboxViewer): boolean {
    if (viewer.role === UserRole.VIEWER) return false;
    return IMPLICIT_ALL_ROLES.includes(viewer.role) || viewer.grants.includes('chat.assign');
}

/** Viewers read; everyone else in the inbox may reply. */
export function canReply(viewer: InboxViewer): boolean {
    return viewer.role !== UserRole.VIEWER;
}

/** Teams, shared quick replies and shared views are run by owners, admins and managers. */
export function canManageInbox(viewer: InboxViewer): boolean {
    return IMPLICIT_ALL_ROLES.includes(viewer.role);
}
