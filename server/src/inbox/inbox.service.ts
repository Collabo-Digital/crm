import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationStatus, MessageDirection, MessageKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from '../commerce/catalog.service';
import { StoreActionsService } from '../commerce/store-actions.service';
import { InboxEventsService } from '../messaging/inbox-events.service';
import { MessagingSendService, SendOutcome } from '../messaging/send/messaging-send.service';
import { MessagingMediaStorage } from '../messaging/media/messaging-media.storage';
import { signMediaPath, verifyMediaSignature } from '../messaging/media/media-url';
import { replyWindow } from '../messaging/outbound';
import { InboxViewer, canAssign, canAssignOthers, canReply, visibilityWhere } from './inbox-visibility';
import { ConversationFilters, conversationWhere, openWhere } from './inbox-filters';
import { ASSIGNABLE_ROLES, InboxTeamService } from './inbox-team.service';
import { InboxContactsService } from './inbox-contacts.service';
import { contactName } from '../messaging/contact-name';
import { InboxViewService } from './inbox-view.service';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { CreateNoteDto } from './dto/create-note.dto';
import { BulkConversationsDto } from './dto/bulk-conversations.dto';
import { asOutbound, parseSendPayload } from './send-payload.schema';

/** Files the composer may attach, by the media kind they are sent as. */
const UPLOAD_KINDS: Record<string, 'image' | 'video' | 'audio' | 'document'> = {
    'image/jpeg': 'image',
    'image/png': 'image',
    'image/webp': 'image',
    'video/mp4': 'video',
    'video/3gpp': 'video',
    'audio/mpeg': 'audio',
    'audio/mp4': 'audio',
    'audio/aac': 'audio',
    'audio/ogg': 'audio',
    'audio/amr': 'audio',
    'application/pdf': 'document',
    'application/msword': 'document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
    'application/vnd.ms-excel': 'document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
    'application/vnd.ms-powerpoint': 'document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
    'text/plain': 'document',
};

/// WhatsApp's per-type ceilings; the composer's upload uses the strictest per kind.
const UPLOAD_MAX_BYTES: Record<'image' | 'video' | 'audio' | 'document', number> = {
    image: 5 * 1024 * 1024,
    video: 16 * 1024 * 1024,
    audio: 16 * 1024 * 1024,
    document: 100 * 1024 * 1024,
};

export interface UploadedFile {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}

const conversationInclude = {
    contact: true,
    channel: { select: { id: true, name: true, platform: true } },
    assignedUser: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
    team: { select: { id: true, name: true } },
} satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

/** What one conversation update asks for; the single and bulk paths share it. */
interface ConversationChange {
    assignedUserId?: string | null;
    teamId?: string | null;
    status?: 'OPEN' | 'CLOSED' | 'SNOOZED';
    snoozedUntil?: string;
}

/** The inbox's read side and the actions a member takes on a conversation. */
@Injectable()
export class InboxService {
    private readonly linkSecret: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly sender: MessagingSendService,
        private readonly storage: MessagingMediaStorage,
        private readonly events: InboxEventsService,
        private readonly teams: InboxTeamService,
        private readonly contacts: InboxContactsService,
        private readonly views: InboxViewService,
        private readonly catalog: CatalogService,
        private readonly storeActions: StoreActionsService,
        config: ConfigService,
    ) {
        this.linkSecret = config.get<string>('messaging.linkSecret')!;
    }

    // ─── Conversations ────────────────────────────────────────────────

    async listConversations(orgId: string, viewer: InboxViewer, q: QueryConversationsDto) {
        const now = new Date();
        const limit = q.limit ?? 30;
        const filters: ConversationFilters = {
            view: q.view,
            status: q.status,
            channelId: q.channelId,
            platform: q.platform,
            tag: q.tag,
            teamId: q.teamId,
            assigneeId: q.assigneeId,
            unread: q.unread === 'true',
            comments: q.comments === 'true',
            search: q.search,
        };
        const where = conversationWhere(orgId, viewer, filters, now);
        if (q.beforeAt && q.beforeId) {
            const at = new Date(q.beforeAt);
            (where.AND as Prisma.ConversationWhereInput[]).push({
                OR: [{ lastMessageAt: { lt: at } }, { lastMessageAt: at, id: { lt: q.beforeId } }],
            });
        }

        const rows = await this.prisma.conversation.findMany({
            where,
            include: conversationInclude,
            orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
            take: limit + 1,
        });
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
            items: page.map((row) => this.toConversationView(row, now)),
            nextCursor: rows.length > limit && last ? { beforeAt: last.lastMessageAt?.toISOString(), beforeId: last.id } : null,
        };
    }

    /** Badge counts among open conversations the member may see: per view, per team, per saved view. */
    async counts(orgId: string, viewer: InboxViewer) {
        const now = new Date();
        const open = { AND: [{ organizationId: orgId }, openWhere(now), visibilityWhere(viewer)] };
        const [mine, unassigned, all, unread, byTeam, views] = await Promise.all([
            this.prisma.conversation.count({ where: { AND: [open, { assignedUserId: viewer.userId }] } }),
            this.prisma.conversation.count({ where: { AND: [open, { assignedUserId: null }] } }),
            this.prisma.conversation.count({ where: open }),
            this.prisma.conversation.count({ where: { AND: [open, { unreadCount: { gt: 0 } }] } }),
            this.prisma.conversation.groupBy({
                by: ['teamId'],
                where: { AND: [open, { teamId: { not: null } }] },
                _count: { _all: true },
            }),
            this.views.counts(orgId, viewer, now),
        ]);
        return {
            mine,
            unassigned,
            all,
            unread,
            teams: Object.fromEntries(byTeam.map((t) => [t.teamId!, t._count._all])),
            views,
        };
    }

    async getConversation(orgId: string, viewer: InboxViewer, id: string) {
        const row = await this.loadConversation(orgId, viewer, id);
        const view = this.toConversationView(row, new Date());
        return {
            ...view,
            contact: await this.contacts.view(row.contact),
            reply: {
                canReply: canReply(viewer),
                window: replyWindow(row.platform, row.lastInboundAt),
            },
        };
    }

    async listMessages(orgId: string, viewer: InboxViewer, id: string, q: QueryMessagesDto) {
        const conversation = await this.loadConversation(orgId, viewer, id);
        const limit = q.limit ?? 50;
        const where: Prisma.MessageWhereInput = { conversationId: conversation.id };
        if (q.beforeAt && q.beforeId) {
            const at = new Date(q.beforeAt);
            where.OR = [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: q.beforeId } }];
        }
        const rows = await this.prisma.message.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
        });
        const page = rows.slice(0, limit).reverse();
        const replyIds = [...new Set(page.map((m) => m.replyToMessageId).filter((x): x is string => !!x))];
        const userIds = [...new Set(page.map((m) => m.sentByUserId).filter((x): x is string => !!x))];
        const comments = page.filter((m) => m.kind === MessageKind.COMMENT && m.direction === MessageDirection.INBOUND && m.externalId);
        const quotedQuery = this.prisma.message.findMany({
            where: { id: { in: replyIds } },
            select: { id: true, text: true, kind: true, direction: true },
        });
        const usersQuery = this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, firstName: true, lastName: true },
        });
        // Notes are few; they come whole with the newest page.
        const notesQuery = q.beforeAt
            ? Promise.resolve([])
            : this.prisma.conversationNote.findMany({
                where: { conversationId: conversation.id },
                orderBy: { createdAt: 'asc' },
                include: { author: { select: { id: true, firstName: true, lastName: true } } },
            });
        const repliesQuery = this.prisma.message.findMany({
            where: {
                conversationId: conversation.id,
                direction: MessageDirection.OUTBOUND,
                inReplyToExternalId: { in: comments.map((c) => c.externalId!) },
                status: { not: 'FAILED' },
            },
            select: { kind: true, inReplyToExternalId: true },
        });
        const [quoted, users, notes, commentReplies, posts] = await Promise.all([
            quotedQuery,
            usersQuery,
            notesQuery,
            repliesQuery,
            this.postsFor(conversation.channelId, comments.map((c) => (c.body as { postId?: string } | null)?.postId)),
        ]);
        const quotedById = new Map(quoted.map((m) => [m.id, m]));
        const userById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
        const oldest = page[0];
        return {
            messages: page.map((m) => ({
                id: m.id,
                direction: m.direction,
                kind: m.kind,
                source: m.source,
                text: m.text,
                status: m.status,
                createdAt: m.createdAt,
                sentAt: m.sentAt,
                deliveredAt: m.deliveredAt,
                readAt: m.readAt,
                failedAt: m.failedAt,
                errorMessage: m.errorMessage,
                imported: m.imported,
                editedAt: m.editedAt,
                revokedAt: m.revokedAt,
                reactions: m.reactions,
                templateName: m.templateName,
                sentBy: m.sentByUserId ? { id: m.sentByUserId, name: userById.get(m.sentByUserId) ?? null } : null,
                replyTo: m.replyToMessageId ? quotedById.get(m.replyToMessageId) ?? null : null,
                media: this.mediaView(m.id, m.media),
                details:
                    m.kind === MessageKind.COMMENT && m.direction === MessageDirection.INBOUND
                        ? this.commentDetails(m, commentReplies, posts)
                        : this.messageDetails(m),
            })),
            notes: notes.map((n) => ({
                id: n.id,
                body: n.body,
                mentions: n.mentions,
                createdAt: n.createdAt,
                author: n.author ? { id: n.author.id, name: `${n.author.firstName} ${n.author.lastName}`.trim() } : null,
            })),
            nextCursor: rows.length > limit && oldest ? { beforeAt: oldest.createdAt.toISOString(), beforeId: oldest.id } : null,
        };
    }

    async send(orgId: string, viewer: InboxViewer, id: string, dto: SendMessageDto): Promise<SendOutcome> {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot send messages.');
        const conversation = await this.loadConversation(orgId, viewer, id);
        const input = parseSendPayload(dto.payload);
        const idempotencyKey = dto.clientId ? `inbox:${viewer.userId}:${dto.clientId}` : null;
        const base = {
            organizationId: orgId,
            conversationId: conversation.id,
            origin: 'agent' as const,
            actorUserId: viewer.userId,
            replyToMessageId: dto.replyToMessageId ?? null,
            idempotencyKey,
        };

        if (input.type === 'reaction' || input.type === 'private_reply' || input.type === 'comment_reply') {
            const targetId = input.type === 'reaction' ? input.messageId : input.commentMessageId;
            const target = await this.prisma.message.findFirst({
                where: { id: targetId, conversationId: conversation.id },
                select: { externalId: true, kind: true },
            });
            if (!target?.externalId) throw new BadRequestException('That message cannot be reacted to or replied to yet.');
            if (input.type !== 'reaction' && target.kind !== MessageKind.COMMENT) {
                throw new BadRequestException('Only comments can be replied to this way.');
            }
            const payload =
                input.type === 'reaction'
                    ? { type: 'reaction' as const, targetExternalId: target.externalId, emoji: input.emoji }
                    : { type: input.type, commentId: target.externalId, text: input.text };
            return this.sender.send({ ...base, payload, replyToMessageId: null });
        }
        if (input.type === 'products') {
            return this.sender.send({ ...base, payload: await this.catalog.productPayload(orgId, conversation.channelId, input) });
        }
        return this.sender.send({ ...base, payload: asOutbound(input) });
    }

    /** The store's products for the composer's product tray, with what this conversation's channel can send. */
    async products(orgId: string, viewer: InboxViewer, id: string, search: string | undefined) {
        const conversation = await this.loadConversation(orgId, viewer, id);
        return this.catalog.products(orgId, conversation.channelId, search);
    }

    /** A draft order from a cart the customer sent, with Shopify's checkout link when a store is connected. */
    async draftFromCart(orgId: string, viewer: InboxViewer, id: string, messageId: string) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot create orders.');
        const conversation = await this.loadConversation(orgId, viewer, id);
        const message = await this.prisma.message.findFirst({
            where: { id: messageId, conversationId: conversation.id, kind: MessageKind.ORDER },
            select: { body: true },
        });
        if (!message) throw new NotFoundException('Cart not found');
        const items = ((message.body as { order?: { product_items?: Array<{ product_retailer_id?: string; quantity?: number }> } } | null)?.order?.product_items ?? [])
            .filter((i) => i.product_retailer_id)
            .map((i) => ({ retailerId: String(i.product_retailer_id), quantity: Number(i.quantity) || 1 }));
        if (!items.length) throw new BadRequestException('This cart has no items.');
        const name = contactName(conversation.contact).replace(/^@/, '');
        return this.storeActions.draftFromCart(orgId, viewer.userId, {
            lines: items,
            customerId: conversation.customerId,
            phone: conversation.contact.phone,
            firstName: /\p{L}/u.test(name) ? name.split(/\s+/)[0] : null,
            note: 'Cart sent on WhatsApp',
            sourceMessageId: messageId,
        });
    }

    async markRead(orgId: string, viewer: InboxViewer, id: string) {
        const conversation = await this.loadConversation(orgId, viewer, id);
        if (conversation.unreadCount === 0) return { unreadCount: 0 };
        await this.prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
        this.events.publish(orgId, { type: 'conversation.updated', conversationId: conversation.id });
        if (canReply(viewer)) await this.sender.markRead(conversation.id);
        return { unreadCount: 0 };
    }

    async update(orgId: string, viewer: InboxViewer, id: string, dto: UpdateConversationDto) {
        const conversation = await this.loadConversation(orgId, viewer, id);
        const data = await this.changeData(orgId, viewer, conversation, dto);
        if (!data) return this.getConversation(orgId, viewer, id);

        await this.prisma.conversation.update({ where: { id: conversation.id }, data });
        this.events.publish(orgId, { type: 'conversation.updated', conversationId: conversation.id });
        try {
            return await this.getConversation(orgId, viewer, id);
        } catch (err) {
            // Unassigning yourself can take the conversation out of your view.
            if (err instanceof NotFoundException) return { id, visible: false };
            throw err;
        }
    }

    /**
     * One action on many conversations. Each is checked as if done alone;
     * the ones the member may not change are reported, not fatal.
     */
    async bulk(orgId: string, viewer: InboxViewer, dto: BulkConversationsDto) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot change conversations.');
        const ids = [...new Set(dto.ids)];
        const rows = await this.prisma.conversation.findMany({
            where: { AND: [{ id: { in: ids }, organizationId: orgId }, visibilityWhere(viewer)] },
            include: conversationInclude,
        });
        const skipped: Array<{ id: string; reason: string }> = ids
            .filter((id) => !rows.some((r) => r.id === id))
            .map((id) => ({ id, reason: 'Not found' }));

        if (dto.action === 'mark_read') {
            // Clears the badge only. Read receipts go out when someone opens the chat.
            const { count } = await this.prisma.conversation.updateMany({
                where: { id: { in: rows.map((r) => r.id) }, unreadCount: { gt: 0 } },
                data: { unreadCount: 0 },
            });
            this.publishAll(orgId, rows.map((r) => r.id));
            return { updated: count, skipped };
        }

        if (dto.action === 'tag' || dto.action === 'untag') {
            const tag = dto.tag?.trim();
            if (!tag) throw new BadRequestException('Choose a tag.');
            const result = await this.contacts.bulkTag(orgId, viewer, {
                ids: [...new Set(rows.map((r) => r.contactId))],
                ...(dto.action === 'tag' ? { add: [tag] } : { remove: [tag] }),
            });
            return { updated: result.updated, skipped };
        }

        const change: ConversationChange =
            dto.action === 'assign'
                ? { assignedUserId: dto.assignedUserId ?? null }
                : dto.action === 'team'
                    ? { teamId: dto.teamId ?? null }
                    : dto.action === 'close'
                        ? { status: 'CLOSED' }
                        : dto.action === 'reopen'
                            ? { status: 'OPEN' }
                            : { status: 'SNOOZED', snoozedUntil: dto.snoozedUntil };
        let updated = 0;
        for (const row of rows) {
            try {
                const data = await this.changeData(orgId, viewer, row, change);
                if (!data) continue;
                await this.prisma.conversation.update({ where: { id: row.id }, data });
                this.events.publish(orgId, { type: 'conversation.updated', conversationId: row.id });
                updated++;
            } catch (err) {
                if (err instanceof ForbiddenException || err instanceof BadRequestException) {
                    skipped.push({ id: row.id, reason: err.message });
                    continue;
                }
                throw err;
            }
        }
        return { updated, skipped };
    }

    async addNote(orgId: string, viewer: InboxViewer, id: string, dto: CreateNoteDto) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot add notes.');
        const conversation = await this.loadConversation(orgId, viewer, id);
        const note = await this.prisma.conversationNote.create({
            data: {
                organizationId: orgId,
                conversationId: conversation.id,
                authorUserId: viewer.userId,
                body: dto.body.trim(),
                mentions: dto.mentions ?? [],
            },
            include: { author: { select: { id: true, firstName: true, lastName: true } } },
        });
        this.events.publish(orgId, { type: 'note.created', conversationId: conversation.id, noteId: note.id });
        return {
            id: note.id,
            body: note.body,
            mentions: note.mentions,
            createdAt: note.createdAt,
            author: note.author ? { id: note.author.id, name: `${note.author.firstName} ${note.author.lastName}`.trim() } : null,
        };
    }

    // ─── Media ────────────────────────────────────────────────────────

    async upload(orgId: string, file: UploadedFile | undefined) {
        if (!file) throw new BadRequestException('Choose a file to attach.');
        const mime = file.mimetype.split(';')[0].trim().toLowerCase();
        const mediaKind = UPLOAD_KINDS[mime];
        if (!mediaKind) throw new BadRequestException('This file type cannot be sent. Use an image, video, audio file, PDF or Office document.');
        if (file.size > UPLOAD_MAX_BYTES[mediaKind]) {
            throw new BadRequestException(`${mediaKind[0].toUpperCase()}${mediaKind.slice(1)}s can be at most ${UPLOAD_MAX_BYTES[mediaKind] / 1024 / 1024} MB.`);
        }
        const saved = await this.storage.save(orgId, file.buffer, mime);
        return { storageKey: saved.storageKey, mime, size: saved.size, filename: file.originalname, mediaKind };
    }

    /** Stream a stored file behind a signed link. */
    async openMedia(messageId: string, exp: string | undefined, sig: string | undefined) {
        if (!verifyMediaSignature(this.linkSecret, messageId, exp, sig)) throw new ForbiddenException('This link has expired.');
        const message = await this.prisma.message.findUnique({ where: { id: messageId }, select: { media: true, revokedAt: true } });
        const media = message?.media as { storageKey?: string; mime?: string; filename?: string } | null;
        if (!media?.storageKey || message?.revokedAt) throw new NotFoundException('File not found');
        const file = await this.storage.open(media.storageKey);
        return { ...file, mime: media.mime ?? 'application/octet-stream', filename: media.filename ?? null };
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    private async loadConversation(orgId: string, viewer: InboxViewer, id: string): Promise<ConversationRow> {
        const row = await this.prisma.conversation.findFirst({
            where: { AND: [{ id, organizationId: orgId }, visibilityWhere(viewer)] },
            include: conversationInclude,
        });
        if (!row) throw new NotFoundException('Conversation not found');
        return row;
    }

    /** The update a change makes, after checking the member may make it; null when nothing changes. */
    private async changeData(
        orgId: string,
        viewer: InboxViewer,
        conversation: ConversationRow,
        change: ConversationChange,
    ): Promise<Prisma.ConversationUpdateInput | null> {
        const data: Prisma.ConversationUpdateInput = {};

        if (change.assignedUserId !== undefined && change.assignedUserId !== conversation.assignedUserId) {
            if (!canAssign(viewer, conversation.assignedUserId, change.assignedUserId)) {
                throw new ForbiddenException('You cannot assign this conversation to someone else.');
            }
            if (change.assignedUserId) {
                const member = await this.prisma.organizationMember.findFirst({
                    where: { organizationId: orgId, userId: change.assignedUserId, isActive: true, role: { in: ASSIGNABLE_ROLES } },
                    select: { id: true },
                });
                if (!member) throw new BadRequestException('That person is not an active team member who can reply.');
            }
            data.assignedUser = change.assignedUserId ? { connect: { id: change.assignedUserId } } : { disconnect: true };
        }

        if (change.teamId !== undefined && change.teamId !== conversation.teamId) {
            if (!canAssignOthers(viewer)) throw new ForbiddenException('You cannot move this conversation to another team.');
            if (change.teamId) await this.teams.assertTeam(orgId, change.teamId);
            data.team = change.teamId ? { connect: { id: change.teamId } } : { disconnect: true };
        }

        if (change.status) {
            if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot change a conversation.');
            if (change.status === 'SNOOZED') {
                const until = change.snoozedUntil ? new Date(change.snoozedUntil) : null;
                if (!until || until <= new Date()) throw new BadRequestException('Choose a snooze time in the future.');
                Object.assign(data, { status: ConversationStatus.SNOOZED, snoozedUntil: until });
            } else if (change.status === 'CLOSED') {
                Object.assign(data, { status: ConversationStatus.CLOSED, closedAt: new Date(), closedById: viewer.userId, snoozedUntil: null });
            } else {
                Object.assign(data, {
                    status: ConversationStatus.OPEN,
                    snoozedUntil: null,
                    closedAt: null,
                    closedById: null,
                    ...(conversation.status === ConversationStatus.CLOSED ? { openedAt: new Date() } : {}),
                });
            }
        }
        return Object.keys(data).length ? data : null;
    }

    private toConversationView(row: ConversationRow, now: Date) {
        const window = replyWindow(row.platform, row.lastInboundAt, now);
        const due = row.status === ConversationStatus.SNOOZED && row.snoozedUntil && row.snoozedUntil <= now;
        return {
            id: row.id,
            platform: row.platform,
            status: due ? ConversationStatus.OPEN : row.status,
            snoozedUntil: due ? null : row.snoozedUntil,
            channel: row.channel,
            contact: {
                id: row.contact.id,
                name: contactName(row.contact),
                username: row.contact.username,
                phone: row.contact.phone,
                avatarUrl: row.contact.profilePicUrl,
                tags: row.contact.tags,
                optedOut: !!row.contact.optedOutAt,
                blocked: !!row.contact.blockedAt,
            },
            customerId: row.customerId,
            assignee: row.assignedUser
                ? { id: row.assignedUser.id, name: `${row.assignedUser.firstName} ${row.assignedUser.lastName}`.trim(), avatarUrl: row.assignedUser.avatarUrl }
                : null,
            team: row.team,
            lastMessagePreview: row.lastMessagePreview,
            lastMessageAt: row.lastMessageAt,
            lastInboundAt: row.lastInboundAt,
            unreadCount: row.unreadCount,
            awaitingReplySince: row.awaitingReplySince,
            window: { open: window.open, closesAt: window.closesAt, humanAgentUntil: window.humanAgentUntil },
        };
    }

    private mediaView(messageId: string, media: Prisma.JsonValue) {
        const m = media as { storageKey?: string; mime?: string; filename?: string; size?: number; voice?: boolean; url?: string; doNotStore?: boolean; error?: string } | null;
        if (!m) return null;
        return {
            mime: m.mime ?? null,
            filename: m.filename ?? null,
            size: m.size ?? null,
            voice: m.voice ?? false,
            // Story mentions may not be stored; Meta's own link is shown until it expires.
            url: m.storageKey ? signMediaPath(this.linkSecret, messageId) : m.doNotStore ? (m.url ?? null) : null,
            pending: !m.storageKey && !m.doNotStore && !m.error,
            error: m.error ?? null,
        };
    }

    /** The structured bits a bubble needs beyond text: buttons sent, a cart, a location. */
    private messageDetails(m: { direction: MessageDirection; kind: string; body: Prisma.JsonValue }) {
        const body = (m.body ?? {}) as Record<string, any>;
        if (m.direction === MessageDirection.OUTBOUND && body.payload) {
            const { storageKey: _s, ...payload } = body.payload as Record<string, unknown>;
            return { payload };
        }
        switch (m.kind) {
            case 'ORDER':
                return { order: body.order ?? null };
            case 'LOCATION':
                return { location: body.location ?? null };
            case 'CONTACTS':
                return { contacts: body.contacts ?? null };
            case 'INTERACTIVE':
                return { reply: body.interactive ?? body.button ?? body.postback ?? null };
            default:
                return body.referral ? { referral: body.referral } : null;
        }
    }

    /**
     * A comment, with the post it is on and whether the team has already
     * answered it — Meta allows one private reply per comment.
     */
    private commentDetails(
        m: { externalId: string | null; body: Prisma.JsonValue },
        replies: Array<{ kind: MessageKind; inReplyToExternalId: string | null }>,
        posts: Map<string, { permalink: string | null; thumbnailUrl: string | null; caption: string | null }>,
    ) {
        const body = (m.body ?? {}) as { postId?: string; parentId?: string; mediaProductType?: string };
        const mine = replies.filter((r) => r.inReplyToExternalId === m.externalId);
        return {
            comment: {
                postId: body.postId ?? null,
                parentId: body.parentId ?? null,
                mediaProductType: body.mediaProductType ?? null,
                post: body.postId ? posts.get(body.postId) ?? null : null,
                privateReplied: mine.some((r) => r.kind === MessageKind.PRIVATE_REPLY),
                publicReplied: mine.some((r) => r.kind === MessageKind.COMMENT),
            },
        };
    }

    private async postsFor(channelId: string, postIds: Array<string | undefined>) {
        const ids = [...new Set(postIds.filter((x): x is string => !!x))];
        if (!ids.length) return new Map<string, { permalink: string | null; thumbnailUrl: string | null; caption: string | null }>();
        const rows = await this.prisma.channelMedia.findMany({
            where: { channelId, externalId: { in: ids } },
            select: { externalId: true, permalink: true, thumbnailUrl: true, caption: true },
        });
        return new Map(rows.map((r) => [r.externalId, { permalink: r.permalink, thumbnailUrl: r.thumbnailUrl, caption: r.caption }]));
    }

    private publishAll(orgId: string, conversationIds: string[]) {
        for (const id of conversationIds) this.events.publish(orgId, { type: 'conversation.updated', conversationId: id });
    }
}
