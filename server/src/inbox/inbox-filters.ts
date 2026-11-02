import { BadRequestException } from '@nestjs/common';
import { ChannelPlatform, ConversationStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { InboxViewer, visibilityWhere } from './inbox-visibility';

/**
 * The filters a conversation list can be narrowed by. The list query and a
 * saved view's stored filters are the same shape, so a view is just a named,
 * shared query.
 */
export const ConversationFiltersSchema = z.object({
    /** mine = assigned to me · unassigned = the queue · all = everything I may see. */
    view: z.enum(['mine', 'unassigned', 'all']).optional(),
    /** open includes snoozed conversations whose time has come. */
    status: z.enum(['open', 'snoozed', 'closed', 'any']).optional(),
    channelId: z.string().max(40).optional(),
    platform: z.enum(ChannelPlatform).optional(),
    tag: z.string().max(60).optional(),
    /** A team id, or "none" for conversations with no team. */
    teamId: z.string().max(40).optional(),
    assigneeId: z.string().max(40).optional(),
    unread: z.boolean().optional(),
    /** Only conversations with Instagram or Facebook comments in them. */
    comments: z.boolean().optional(),
    search: z.string().max(120).optional(),
});

export type ConversationFilters = z.infer<typeof ConversationFiltersSchema>;

export function parseFilters(raw: unknown): ConversationFilters {
    const parsed = ConversationFiltersSchema.strict().safeParse(raw ?? {});
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException(`Invalid filter: ${issue.path.join('.') || 'filters'} — ${issue.message}`);
    }
    return parsed.data;
}

/** Open, or snoozed until a time that has passed. */
export const openWhere = (now: Date): Prisma.ConversationWhereInput => ({
    OR: [{ status: ConversationStatus.OPEN }, { status: ConversationStatus.SNOOZED, snoozedUntil: { lte: now } }],
});

/** Every condition the filters add, bounded by what the member may see. */
export function conversationWhere(
    orgId: string,
    viewer: InboxViewer,
    f: ConversationFilters,
    now: Date,
): Prisma.ConversationWhereInput {
    const and: Prisma.ConversationWhereInput[] = [{ organizationId: orgId }, visibilityWhere(viewer)];

    if (f.view === 'mine') and.push({ assignedUserId: viewer.userId });
    if (f.view === 'unassigned') and.push({ assignedUserId: null });
    switch (f.status ?? 'open') {
        case 'open':
            and.push(openWhere(now));
            break;
        case 'snoozed':
            and.push({ status: ConversationStatus.SNOOZED, snoozedUntil: { gt: now } });
            break;
        case 'closed':
            and.push({ status: ConversationStatus.CLOSED });
            break;
    }
    if (f.channelId) and.push({ channelId: f.channelId });
    if (f.platform) and.push({ platform: f.platform });
    if (f.tag) and.push({ contact: { tags: { has: f.tag } } });
    if (f.teamId) and.push({ teamId: f.teamId === 'none' ? null : f.teamId });
    if (f.assigneeId) and.push({ assignedUserId: f.assigneeId });
    if (f.unread) and.push({ unreadCount: { gt: 0 } });
    if (f.comments) and.push({ messages: { some: { kind: 'COMMENT' } } });
    if (f.search?.trim()) {
        const term = f.search.trim();
        const like = { contains: term, mode: 'insensitive' as const };
        and.push({
            OR: [
                { contact: { displayName: like } },
                { contact: { addressBookName: like } },
                { contact: { username: like } },
                { contact: { phone: { contains: term.replace(/[^\d+]/g, '') || term } } },
                { lastMessagePreview: like },
                { messages: { some: { text: like } } },
            ],
        });
    }
    return { AND: and };
}
