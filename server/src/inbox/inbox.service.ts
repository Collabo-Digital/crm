import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    ChannelContact,
    ConsentType,
    ConversationStatus,
    MessageDirection,
    Prisma,
    UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentService } from '../messaging/consent.service';
import { InboxEventsService } from '../messaging/inbox-events.service';
import { MessagingSendService, SendOutcome } from '../messaging/send/messaging-send.service';
import { MessagingMediaStorage } from '../messaging/media/messaging-media.storage';
import { signMediaPath, verifyMediaSignature } from '../messaging/media/media-url';
import { replyWindow } from '../messaging/outbound';
import { InboxViewer, canAssign, canReply, seesUnassigned, visibilityWhere } from './inbox-visibility';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { RecordConsentDto } from './dto/record-consent.dto';
import { asOutbound, parseSendPayload } from './send-payload.schema';

const ASSIGNABLE_ROLES: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT];

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
} satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

export function contactName(c: Pick<ChannelContact, 'displayName' | 'addressBookName' | 'username' | 'phone' | 'externalId'>): string {
    return c.displayName ?? c.addressBookName ?? (c.username ? `@${c.username}` : null) ?? c.phone ?? c.externalId;
}

/** The inbox's read side and the actions a member takes on a conversation. */
@Injectable()
export class InboxService {
    private readonly linkSecret: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly sender: MessagingSendService,
        private readonly consent: ConsentService,
        private readonly storage: MessagingMediaStorage,
        private readonly events: InboxEventsService,
        config: ConfigService,
    ) {
        this.linkSecret = config.get<string>('messaging.linkSecret')!;
    }

    // ─── Conversations ────────────────────────────────────────────────

    async listConversations(orgId: string, viewer: InboxViewer, q: QueryConversationsDto) {
        const now = new Date();
        const limit = q.limit ?? 30;
        const and: Prisma.ConversationWhereInput[] = [{ organizationId: orgId }, visibilityWhere(viewer)];

        if (q.view === 'mine') and.push({ assignedUserId: viewer.userId });
        if (q.view === 'unassigned') {
            if (!seesUnassigned(viewer)) throw new ForbiddenException('You cannot see unassigned conversations.');
            and.push({ assignedUserId: null });
        }
        switch (q.status ?? 'open') {
            case 'open':
                and.push({
                    OR: [
                        { status: ConversationStatus.OPEN },
                        { status: ConversationStatus.SNOOZED, snoozedUntil: { lte: now } },
                    ],
                });
                break;
            case 'snoozed':
                and.push({ status: ConversationStatus.SNOOZED, snoozedUntil: { gt: now } });
                break;
            case 'closed':
                and.push({ status: ConversationStatus.CLOSED });
                break;
        }
        if (q.channelId) and.push({ channelId: q.channelId });
        if (q.platform) and.push({ platform: q.platform });
        if (q.tag) and.push({ contact: { tags: { has: q.tag } } });
        if (q.unread === 'true') and.push({ unreadCount: { gt: 0 } });
        if (q.search?.trim()) {
            const term = q.search.trim();
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
        if (q.beforeAt && q.beforeId) {
            const at = new Date(q.beforeAt);
            and.push({ OR: [{ lastMessageAt: { lt: at } }, { lastMessageAt: at, id: { lt: q.beforeId } }] });
        }

        const rows = await this.prisma.conversation.findMany({
            where: { AND: and },
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

    /** Badge counts for the views, among open conversations the member may see. */
    async counts(orgId: string, viewer: InboxViewer) {
        const now = new Date();
        const open: Prisma.ConversationWhereInput = {
            organizationId: orgId,
            OR: [{ status: ConversationStatus.OPEN }, { status: ConversationStatus.SNOOZED, snoozedUntil: { lte: now } }],
        };
        const visible = visibilityWhere(viewer);
        const [mine, unassigned, all, unread] = await Promise.all([
            this.prisma.conversation.count({ where: { AND: [open, { assignedUserId: viewer.userId }] } }),
            seesUnassigned(viewer)
                ? this.prisma.conversation.count({ where: { AND: [open, { assignedUserId: null }] } })
                : Promise.resolve(0),
            this.prisma.conversation.count({ where: { AND: [open, visible] } }),
            this.prisma.conversation.count({ where: { AND: [open, visible, { unreadCount: { gt: 0 } }] } }),
        ]);
        return { mine, unassigned, all, unread };
    }

    async getConversation(orgId: string, viewer: InboxViewer, id: string) {
        const row = await this.loadConversation(orgId, viewer, id);
        const view = this.toConversationView(row, new Date());
        return {
            ...view,
            contact: await this.contactView(row.contact),
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
        const quoted = replyIds.length
            ? await this.prisma.message.findMany({
                where: { id: { in: replyIds } },
                select: { id: true, text: true, kind: true, direction: true },
            })
            : [];
        const users = userIds.length
            ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })
            : [];
        // Notes are few; they come whole with the newest page.
        const notes = q.beforeAt
            ? []
            : await this.prisma.conversationNote.findMany({
                where: { conversationId: conversation.id },
                orderBy: { createdAt: 'asc' },
                include: { author: { select: { id: true, firstName: true, lastName: true } } },
            });
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
                details: this.messageDetails(m),
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

        if (input.type === 'reaction' || input.type === 'private_reply') {
            const targetId = input.type === 'reaction' ? input.messageId : input.commentMessageId;
            const target = await this.prisma.message.findFirst({
                where: { id: targetId, conversationId: conversation.id },
                select: { externalId: true, kind: true },
            });
            if (!target?.externalId) throw new BadRequestException('That message cannot be reacted to or replied to yet.');
            const payload =
                input.type === 'reaction'
                    ? { type: 'reaction' as const, targetExternalId: target.externalId, emoji: input.emoji }
                    : { type: 'private_reply' as const, commentId: target.externalId, text: input.text };
            return this.sender.send({ ...base, payload, replyToMessageId: null });
        }
        return this.sender.send({ ...base, payload: asOutbound(input) });
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
        const data: Prisma.ConversationUpdateInput = {};

        if (dto.assignedUserId !== undefined && dto.assignedUserId !== conversation.assignedUserId) {
            if (!canAssign(viewer, conversation.assignedUserId, dto.assignedUserId)) {
                throw new ForbiddenException('You cannot assign this conversation to someone else.');
            }
            if (dto.assignedUserId) {
                const member = await this.prisma.organizationMember.findFirst({
                    where: { organizationId: orgId, userId: dto.assignedUserId, isActive: true, role: { in: ASSIGNABLE_ROLES } },
                    select: { id: true },
                });
                if (!member) throw new BadRequestException('That person is not an active team member who can reply.');
            }
            data.assignedUser = dto.assignedUserId ? { connect: { id: dto.assignedUserId } } : { disconnect: true };
        }

        if (dto.status) {
            if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot change a conversation.');
            if (dto.status === 'SNOOZED') {
                const until = dto.snoozedUntil ? new Date(dto.snoozedUntil) : null;
                if (!until || until <= new Date()) throw new BadRequestException('Choose a snooze time in the future.');
                Object.assign(data, { status: ConversationStatus.SNOOZED, snoozedUntil: until });
            } else if (dto.status === 'CLOSED') {
                Object.assign(data, { status: ConversationStatus.CLOSED, closedAt: new Date(), closedById: viewer.userId, snoozedUntil: null });
            } else {
                Object.assign(data, { status: ConversationStatus.OPEN, snoozedUntil: null, closedAt: null, closedById: null });
            }
        }
        if (Object.keys(data).length === 0) return this.getConversation(orgId, viewer, id);

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

    // ─── Contacts ─────────────────────────────────────────────────────

    async getContact(orgId: string, viewer: InboxViewer, contactId: string) {
        const contact = await this.prisma.channelContact.findFirst({ where: { id: contactId, organizationId: orgId } });
        if (!contact) throw new NotFoundException('Contact not found');
        await this.assertSeesContact(orgId, viewer, contact.id);
        return this.contactView(contact);
    }

    async updateContact(orgId: string, viewer: InboxViewer, contactId: string, dto: UpdateContactDto) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot edit contacts.');
        const contact = await this.prisma.channelContact.findFirst({ where: { id: contactId, organizationId: orgId } });
        if (!contact) throw new NotFoundException('Contact not found');
        await this.assertSeesContact(orgId, viewer, contact.id);

        if (dto.customerId) {
            const customer = await this.prisma.customer.findFirst({
                where: { id: dto.customerId, organizationId: orgId, deletedAt: null },
                select: { id: true },
            });
            if (!customer) throw new BadRequestException('Customer not found');
        }
        const attributes = dto.attributes
            ? Object.fromEntries(Object.entries({ ...((contact.attributes as Record<string, unknown>) ?? {}), ...dto.attributes }).filter(([, v]) => v !== null))
            : undefined;

        const updated = await this.prisma.$transaction(async (tx) => {
            const row = await tx.channelContact.update({
                where: { id: contact.id },
                data: {
                    ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() || null } : {}),
                    ...(dto.tags ? { tags: [...new Set(dto.tags.map((t) => t.trim()).filter(Boolean))] } : {}),
                    ...(attributes ? { attributes: attributes as Prisma.InputJsonValue } : {}),
                    ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
                    ...(dto.blocked !== undefined ? { blockedAt: dto.blocked ? new Date() : null } : {}),
                },
            });
            if (dto.customerId !== undefined) {
                await tx.conversation.updateMany({ where: { contactId: contact.id }, data: { customerId: dto.customerId } });
            }
            return row;
        });
        const conversations = await this.prisma.conversation.findMany({ where: { contactId: contact.id }, select: { id: true } });
        for (const c of conversations) this.events.publish(orgId, { type: 'conversation.updated', conversationId: c.id });
        return this.contactView(updated);
    }

    async recordConsent(orgId: string, viewer: InboxViewer, contactId: string, dto: RecordConsentDto) {
        if (!canReply(viewer)) throw new ForbiddenException('Viewers cannot change consent.');
        const contact = await this.prisma.channelContact.findFirst({ where: { id: contactId, organizationId: orgId } });
        if (!contact) throw new NotFoundException('Contact not found');
        await this.assertSeesContact(orgId, viewer, contact.id);
        await this.prisma.$transaction((tx) =>
            this.consent.record(tx, contact, dto.type as ConsentType, 'agent', dto.note ? { note: dto.note } : null, viewer.userId),
        );
        return this.getContact(orgId, viewer, contact.id);
    }

    /** Active members a conversation can be assigned to. */
    async assignableMembers(orgId: string) {
        const members = await this.prisma.organizationMember.findMany({
            where: { organizationId: orgId, isActive: true, role: { in: ASSIGNABLE_ROLES } },
            select: { role: true, user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
            orderBy: { user: { firstName: 'asc' } },
        });
        return members.map((m) => ({
            id: m.user.id,
            name: `${m.user.firstName} ${m.user.lastName}`.trim(),
            avatarUrl: m.user.avatarUrl,
            role: m.role,
        }));
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

    private async assertSeesContact(orgId: string, viewer: InboxViewer, contactId: string) {
        const visible = await this.prisma.conversation.findFirst({
            where: { AND: [{ contactId, organizationId: orgId }, visibilityWhere(viewer)] },
            select: { id: true },
        });
        if (!visible) throw new NotFoundException('Contact not found');
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
            lastMessagePreview: row.lastMessagePreview,
            lastMessageAt: row.lastMessageAt,
            lastInboundAt: row.lastInboundAt,
            unreadCount: row.unreadCount,
            awaitingReplySince: row.awaitingReplySince,
            window: { open: window.open, closesAt: window.closesAt, humanAgentUntil: window.humanAgentUntil },
        };
    }

    private async contactView(contact: ChannelContact) {
        const [customer, conversations, consent] = await Promise.all([
            contact.customerId
                ? this.prisma.customer.findUnique({
                    where: { id: contact.customerId },
                    select: {
                        id: true, firstName: true, lastName: true, email: true, phone: true, ordersCount: true,
                        totalSpent: true, vipLevel: true, tags: true,
                        orders: {
                            where: { deletedAt: null },
                            orderBy: { createdAt: 'desc' },
                            take: 5,
                            select: { id: true, name: true, totalPrice: true, currency: true, financialStatus: true, fulfillmentStatus: true, createdAt: true, cancelledAt: true },
                        },
                    },
                })
                : Promise.resolve(null),
            // The same person on every channel, through the linked customer.
            this.prisma.conversation.findMany({
                where: contact.customerId
                    ? { organizationId: contact.organizationId, customerId: contact.customerId }
                    : { contactId: contact.id },
                select: { id: true, platform: true, status: true, lastMessageAt: true, lastMessagePreview: true, channel: { select: { name: true } } },
                orderBy: { lastMessageAt: 'desc' },
                take: 10,
            }),
            this.prisma.consentEvent.findMany({
                where: { contactId: contact.id },
                orderBy: { occurredAt: 'desc' },
                take: 10,
                select: { type: true, source: true, occurredAt: true },
            }),
        ]);
        return {
            id: contact.id,
            platform: contact.platform,
            name: contactName(contact),
            displayName: contact.displayName,
            addressBookName: contact.addressBookName,
            username: contact.username,
            phone: contact.phone,
            externalId: contact.externalId,
            avatarUrl: contact.profilePicUrl,
            tags: contact.tags,
            attributes: (contact.attributes as Record<string, unknown> | null) ?? {},
            optedOutAt: contact.optedOutAt,
            optInAt: contact.optInAt,
            blockedAt: contact.blockedAt,
            firstSeenAt: contact.createdAt,
            lastInboundAt: contact.lastInboundMessageAt,
            customer: customer
                ? {
                    id: customer.id,
                    name: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null,
                    email: customer.email,
                    phone: customer.phone,
                    ordersCount: customer.ordersCount,
                    totalSpent: customer.totalSpent.toString(),
                    vipLevel: customer.vipLevel,
                    tags: customer.tags,
                    recentOrders: customer.orders.map((o) => ({ ...o, totalPrice: o.totalPrice.toString() })),
                }
                : null,
            conversations,
            consent,
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
            case 'COMMENT':
                return { postId: body.postId ?? null, parentId: body.parentId ?? null };
            case 'INTERACTIVE':
                return { reply: body.interactive ?? body.button ?? body.postback ?? null };
            default:
                return body.referral ? { referral: body.referral } : null;
        }
    }
}
