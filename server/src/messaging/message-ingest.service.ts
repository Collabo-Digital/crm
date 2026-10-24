import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
    ChannelPlatform,
    ConsentType,
    ConversationStatus,
    MessageDirection,
    MessageKind,
    MessageSource,
    MessageStatus,
    Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsageMeter } from '../billing/usage-meter';
import { ContactIdentityService, ContactRef, ContactTouch } from './contact-identity.service';
import { ConsentService, isOptInText, isOptOutText } from './consent.service';
import { AutomationEventService, InboundEventType } from './automation-event.service';
import { InboxEventsService } from './inbox-events.service';
import { BroadcastTracker } from './broadcast-tracker';
import { AutomationJobs } from './automation-jobs';
import { MediaSpec, MessageContent, previewOf } from './message-content';
import { MEDIA_DOWNLOAD_QUEUE, MediaDownloadJobData, MEDIA_DOWNLOAD_JOB_OPTS } from './media/media-download.queue';

export interface IngestChannel {
    id: string;
    organizationId: string;
    platform: ChannelPlatform;
    /** Our own address on the platform: phone number id, Page id, Instagram account id. */
    address: string;
}

interface BaseInput {
    channel: IngestChannel;
    contact: ContactRef;
    /** Platform message id (wamid, mid, comment id). Dedupe key with the channel. */
    externalId: string;
    occurredAt: Date;
    content: MessageContent;
    /** The raw platform message, kept as the row's body. */
    body: Record<string, unknown>;
    replyToExternalId?: string | null;
    /** Imported from the WhatsApp Business app's history. */
    imported?: boolean;
}

export interface InboundInput extends BaseInput {
    /** Another app owns the thread (Messenger standby): store, never automate. */
    standby?: boolean;
    /** History items arrive already delivered and often read. */
    initialStatus?: MessageStatus;
    /** The automation event to raise for a live message, if any. */
    event?: { type: InboundEventType; mediaExternalId?: string | null; extraPayload?: Record<string, unknown> };
    /** Opt-out by keyword or quick-reply payload. */
    consentPayload?: string | null;
}

export interface BusinessInput extends BaseInput {
    source: MessageSource;
    status?: MessageStatus;
}

const STATUS_RANK: Record<MessageStatus, number> = {
    [MessageStatus.QUEUED]: 0,
    [MessageStatus.SENT]: 1,
    [MessageStatus.DELIVERED]: 2,
    [MessageStatus.READ]: 3,
    [MessageStatus.FAILED]: 4,
};

/**
 * Whether a status update may replace the current one. Statuses only move
 * forward — Meta's webhooks arrive out of order — except that a failure
 * reported after `sent` still counts (e.g. 131049, dropped for engagement).
 */
export function statusAdvances(current: MessageStatus, next: MessageStatus): boolean {
    if (current === next) return false;
    if (next === MessageStatus.FAILED) return current !== MessageStatus.READ && current !== MessageStatus.DELIVERED;
    if (current === MessageStatus.FAILED) return false;
    return STATUS_RANK[next] > STATUS_RANK[current];
}

const isUniqueViolation = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Writes what the platforms tell us into contacts, conversations and
 * messages, the same way for WhatsApp, Messenger and Instagram. Every write is
 * idempotent on the platform's message id, because Meta redelivers.
 */
@Injectable()
export class MessageIngestService {
    private readonly logger = new Logger(MessageIngestService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly identity: ContactIdentityService,
        private readonly consent: ConsentService,
        private readonly automationEvents: AutomationEventService,
        private readonly events: InboxEventsService,
        @InjectQueue(MEDIA_DOWNLOAD_QUEUE) private readonly mediaQueue: Queue<MediaDownloadJobData>,
        private readonly broadcastTracker: BroadcastTracker,
        private readonly automationJobs: AutomationJobs,
        private readonly usageMeter: UsageMeter,
    ) { }

    /** A message the customer sent. Returns null for a redelivery. */
    async recordInbound(input: InboundInput): Promise<{ messageId: string; conversationId: string } | null> {
        const { channel } = input;
        const live = !input.imported;
        const existing = await this.prisma.message.findFirst({
            where: { channelId: channel.id, externalId: input.externalId },
            select: { id: true },
        });
        if (existing) return null;

        let result: { messageId: string; conversationId: string; contactId: string; blocked: boolean; needsProfile: boolean };
        let eventId: string | null = null;
        try {
            result = await this.prisma.$transaction(async (tx) => {
                const touch: ContactTouch = live
                    ? { kind: input.content.kind === MessageKind.COMMENT ? 'comment' : 'message', at: input.occurredAt }
                    : { kind: 'none' };
                const contact = await this.identity.resolve(tx, channel, input.contact, touch);
                await this.identity.linkCustomerByPhone(tx, contact);

                const conversation = await this.upsertConversation(tx, channel, contact.id, contact.customerId, {
                    at: input.occurredAt,
                    preview: previewOf(input.content),
                    inbound: true,
                    live,
                    // A comment is public: it does not open the reply window.
                    opensWindow: live && input.content.kind !== MessageKind.COMMENT,
                    reopen: live && !contact.blockedAt,
                });

                const replyTo = await this.findByExternalId(tx, channel.id, input.replyToExternalId);
                const message = await tx.message.create({
                    data: {
                        organizationId: channel.organizationId,
                        channelId: channel.id,
                        platform: channel.platform,
                        direction: MessageDirection.INBOUND,
                        kind: input.content.kind,
                        source: MessageSource.CUSTOMER,
                        conversationId: conversation.id,
                        contactId: contact.id,
                        customerId: contact.customerId,
                        toAddress: channel.address,
                        fromAddress: contact.externalId,
                        text: input.content.text,
                        body: { ...input.body, ...(input.standby ? { standby: true } : {}) } as Prisma.InputJsonValue,
                        media: (input.content.media ?? undefined) as Prisma.InputJsonValue | undefined,
                        status: input.initialStatus ?? MessageStatus.DELIVERED,
                        externalId: input.externalId,
                        deliveredAt: input.occurredAt,
                        replyToExternalId: input.replyToExternalId ?? null,
                        replyToMessageId: replyTo?.id ?? null,
                        imported: !live,
                        createdAt: input.occurredAt,
                    },
                    select: { id: true },
                });

                if (live) {
                    await this.bumpDailyStat(tx, channel.organizationId, contact.id, input.occurredAt, 'inboundCount');
                    if (isOptOutText(input.content.text) || isOptOutText(input.consentPayload)) {
                        await this.consent.record(tx, contact, ConsentType.OPT_OUT, 'keyword', {
                            messageId: message.id,
                            text: input.content.text ?? input.consentPayload,
                        });
                    } else if (contact.optedOutAt && isOptInText(input.content.text)) {
                        await this.consent.record(tx, contact, ConsentType.OPT_IN, 'keyword', {
                            messageId: message.id,
                            text: input.content.text,
                        });
                    }
                    if (input.event && !input.standby && !contact.blockedAt) {
                        eventId = (await this.automationEvents.record(tx, {
                            organizationId: channel.organizationId,
                            channelId: channel.id,
                            eventType: input.event.type,
                            externalId: input.externalId,
                            occurredAt: input.occurredAt,
                            contactId: contact.id,
                            messageId: message.id,
                            mediaExternalId: input.event.mediaExternalId ?? undefined,
                            actorExternalId: contact.externalId,
                            actorUsername: contact.username ?? undefined,
                            text: input.content.text ?? undefined,
                            payload: { ...input.body, ...(input.event.extraPayload ?? {}), newConversation: conversation.started },
                        })).id;
                    }
                }
                return {
                    messageId: message.id,
                    conversationId: conversation.id,
                    contactId: contact.id,
                    blocked: !!contact.blockedAt,
                    needsProfile: channel.platform !== ChannelPlatform.WHATSAPP && !contact.displayName && !contact.metadata,
                };
            });
        } catch (err) {
            // Two deliveries of the same message raced past the check above.
            if (isUniqueViolation(err)) return null;
            throw err;
        }

        this.events.publish(channel.organizationId, { type: 'message.created', conversationId: result.conversationId, messageId: result.messageId });
        this.events.publish(channel.organizationId, { type: 'conversation.updated', conversationId: result.conversationId });
        if (eventId) await this.automationJobs.event(eventId);
        if (live && channel.platform === ChannelPlatform.WHATSAPP && !result.blocked) {
            await this.usageMeter.noteMessage(channel.organizationId, result.contactId, input.occurredAt);
        }
        if (live && input.content.kind !== MessageKind.COMMENT) {
            await this.broadcastTracker.onInbound({
                contactId: result.contactId,
                at: input.occurredAt,
                replyToExternalId: input.replyToExternalId ?? null,
                kind: input.content.kind,
            });
        }
        await this.queueMediaDownload(result.messageId, input.content.media);
        if (result.needsProfile) {
            await this.mediaQueue
                .add('profile', { contactId: result.contactId }, { ...MEDIA_DOWNLOAD_JOB_OPTS, attempts: 2, jobId: `profile-${result.contactId}` })
                .catch((err) => this.logger.warn(`Could not queue profile lookup for ${result.contactId}: ${err}`));
        }
        return { messageId: result.messageId, conversationId: result.conversationId };
    }

    /**
     * A participant's message in a WhatsApp group, filed under the group's
     * contact. It opens the reply window for the whole group (Meta: any
     * participant's message does). Unlike a person's message it records no
     * consent keyword, links no customer and starts no automation.
     */
    async recordGroupInbound(input: {
        channel: IngestChannel;
        contactId: string;
        participant: { waId: string; name: string | null };
        externalId: string;
        occurredAt: Date;
        content: InboundInput['content'];
        body: Record<string, unknown>;
        replyToExternalId: string | null;
    }): Promise<{ messageId: string; conversationId: string } | null> {
        const { channel } = input;
        const existing = await this.prisma.message.findFirst({ where: { channelId: channel.id, externalId: input.externalId }, select: { id: true } });
        if (existing) return null;
        let result: { messageId: string; conversationId: string };
        try {
            result = await this.prisma.$transaction(async (tx) => {
                await tx.channelContact.update({
                    where: { id: input.contactId },
                    data: { lastInboundMessageAt: input.occurredAt, inboundCount: { increment: 1 } },
                });
                const conversation = await this.upsertConversation(tx, channel, input.contactId, null, {
                    at: input.occurredAt,
                    preview: `${input.participant.name ?? `+${input.participant.waId}`}: ${previewOf(input.content)}`,
                    inbound: true,
                    live: true,
                    opensWindow: true,
                    reopen: true,
                });
                const replyTo = await this.findByExternalId(tx, channel.id, input.replyToExternalId);
                const message = await tx.message.create({
                    data: {
                        organizationId: channel.organizationId,
                        channelId: channel.id,
                        platform: channel.platform,
                        direction: MessageDirection.INBOUND,
                        kind: input.content.kind,
                        source: MessageSource.CUSTOMER,
                        conversationId: conversation.id,
                        contactId: input.contactId,
                        toAddress: channel.address,
                        fromAddress: input.participant.waId,
                        text: input.content.text,
                        body: { ...input.body, groupSender: input.participant } as Prisma.InputJsonValue,
                        media: (input.content.media ?? undefined) as Prisma.InputJsonValue | undefined,
                        status: MessageStatus.DELIVERED,
                        externalId: input.externalId,
                        deliveredAt: input.occurredAt,
                        replyToExternalId: input.replyToExternalId,
                        replyToMessageId: replyTo?.id ?? null,
                        createdAt: input.occurredAt,
                    },
                    select: { id: true },
                });
                return { messageId: message.id, conversationId: conversation.id };
            });
        } catch (err) {
            if (isUniqueViolation(err)) return null;
            throw err;
        }
        this.events.publish(channel.organizationId, { type: 'message.created', conversationId: result.conversationId, messageId: result.messageId });
        this.events.publish(channel.organizationId, { type: 'conversation.updated', conversationId: result.conversationId });
        await this.usageMeter.noteMessage(channel.organizationId, input.contactId, input.occurredAt);
        await this.queueMediaDownload(result.messageId, input.content.media);
        return result;
    }

    /**
     * A notice in a contact's chat: someone joined or left a group, a call
     * ended. It does not open the reply window or count as unread.
     */
    async recordNotice(channel: IngestChannel, contactId: string, text: string, at: Date): Promise<void> {
        const conversation = await this.prisma.conversation.findUnique({ where: { channelId_contactId: { channelId: channel.id, contactId } }, select: { id: true } });
        if (!conversation) return;
        const message = await this.prisma.message.create({
            data: {
                organizationId: channel.organizationId,
                channelId: channel.id,
                platform: channel.platform,
                direction: MessageDirection.INBOUND,
                kind: MessageKind.SYSTEM,
                source: MessageSource.SYSTEM,
                conversationId: conversation.id,
                contactId,
                toAddress: channel.address,
                text,
                body: { notice: text } as Prisma.InputJsonValue,
                status: MessageStatus.DELIVERED,
                deliveredAt: at,
                createdAt: at,
            },
            select: { id: true },
        });
        this.events.publish(channel.organizationId, { type: 'message.created', conversationId: conversation.id, messageId: message.id });
    }

    /**
     * A message the business sent somewhere other than this inbox: the
     * WhatsApp Business app on a coexistence number, Meta Business Suite, a
     * history import. Recorded as outbound so the thread is complete.
     */
    async recordBusinessMessage(input: BusinessInput): Promise<{ messageId: string; conversationId: string } | null> {
        const { channel } = input;
        const live = !input.imported;
        const existing = await this.prisma.message.findFirst({
            where: { channelId: channel.id, externalId: input.externalId },
            select: { id: true },
        });
        if (existing) return null;

        let result: { messageId: string; conversationId: string };
        try {
            result = await this.prisma.$transaction(async (tx) => {
                const contact = await this.identity.resolve(tx, channel, input.contact, { kind: 'none' });
                await this.identity.linkCustomerByPhone(tx, contact);
                const conversation = await this.upsertConversation(tx, channel, contact.id, contact.customerId, {
                    at: input.occurredAt,
                    preview: previewOf(input.content),
                    inbound: false,
                    live,
                    opensWindow: false,
                    reopen: false,
                    businessReply: live,
                });
                const replyTo = await this.findByExternalId(tx, channel.id, input.replyToExternalId);
                const status = input.status ?? MessageStatus.SENT;
                const message = await tx.message.create({
                    data: {
                        organizationId: channel.organizationId,
                        channelId: channel.id,
                        platform: channel.platform,
                        direction: MessageDirection.OUTBOUND,
                        kind: input.content.kind,
                        source: input.source,
                        conversationId: conversation.id,
                        contactId: contact.id,
                        customerId: contact.customerId,
                        toAddress: contact.externalId,
                        fromAddress: channel.address,
                        text: input.content.text,
                        body: input.body as Prisma.InputJsonValue,
                        media: (input.content.media ?? undefined) as Prisma.InputJsonValue | undefined,
                        status,
                        externalId: input.externalId,
                        sentAt: input.occurredAt,
                        deliveredAt: STATUS_RANK[status] >= STATUS_RANK.DELIVERED && status !== MessageStatus.FAILED ? input.occurredAt : null,
                        readAt: status === MessageStatus.READ ? input.occurredAt : null,
                        replyToExternalId: input.replyToExternalId ?? null,
                        replyToMessageId: replyTo?.id ?? null,
                        imported: !live,
                        createdAt: input.occurredAt,
                    },
                    select: { id: true },
                });
                if (live) await tx.channelContact.update({ where: { id: contact.id }, data: { lastOutboundAt: input.occurredAt } });
                return { messageId: message.id, conversationId: conversation.id };
            });
        } catch (err) {
            if (isUniqueViolation(err)) return null;
            throw err;
        }
        this.events.publish(channel.organizationId, { type: 'message.created', conversationId: result.conversationId, messageId: result.messageId });
        this.events.publish(channel.organizationId, { type: 'conversation.updated', conversationId: result.conversationId });
        await this.queueMediaDownload(result.messageId, input.content.media);
        return result;
    }

    /** A delivery status for one of our outbound messages. */
    async applyStatus(
        channel: IngestChannel,
        externalId: string,
        update: {
            status: MessageStatus;
            at: Date;
            pricing?: Record<string, unknown> | null;
            error?: { code: string | null; message: string | null } | null;
        },
    ): Promise<boolean> {
        const message = await this.prisma.message.findFirst({
            where: { channelId: channel.id, externalId, direction: MessageDirection.OUTBOUND },
            select: { id: true, status: true, conversationId: true, contactId: true, organizationId: true, sentAt: true },
        });
        if (!message) return false;
        const advance = statusAdvances(message.status, update.status);
        if (!advance && !update.pricing) return false;

        await this.prisma.message.update({
            where: { id: message.id },
            data: {
                ...(advance ? { status: update.status } : {}),
                ...(update.status === MessageStatus.SENT && !message.sentAt ? { sentAt: update.at } : {}),
                ...(advance && update.status === MessageStatus.DELIVERED ? { deliveredAt: update.at } : {}),
                ...(advance && update.status === MessageStatus.READ ? { readAt: update.at } : {}),
                ...(advance && update.status === MessageStatus.FAILED
                    ? { failedAt: update.at, errorCode: update.error?.code ?? null, errorMessage: update.error?.message ?? null }
                    : {}),
                ...(update.pricing ? { pricing: update.pricing as Prisma.InputJsonValue } : {}),
            },
        });
        if (advance && message.contactId) {
            const field =
                update.status === MessageStatus.DELIVERED
                    ? 'deliveredCount'
                    : update.status === MessageStatus.FAILED
                        ? 'failedCount'
                        : null;
            if (field) await this.bumpDailyStat(this.prisma, message.organizationId, message.contactId, update.at, field);
            if (update.status === MessageStatus.FAILED) {
                await this.prisma.channelContact.update({
                    where: { id: message.contactId },
                    data: { outboundFailedCount: { increment: 1 }, consecutiveFailures: { increment: 1 } },
                });
            } else if (update.status === MessageStatus.DELIVERED) {
                await this.prisma.channelContact.update({
                    where: { id: message.contactId },
                    data: { consecutiveFailures: 0 },
                });
            }
        }
        if (advance) await this.broadcastTracker.onStatus(message.id, update.status, update.at, update.error);
        if (message.conversationId) {
            this.events.publish(message.organizationId, { type: 'message.updated', conversationId: message.conversationId, messageId: message.id });
        }
        return advance;
    }

    /**
     * Messenger and Instagram report reads and deliveries as a watermark:
     * everything we sent to this person up to that time.
     */
    async applyWatermark(
        channel: IngestChannel,
        contact: ContactRef,
        status: typeof MessageStatus.DELIVERED | typeof MessageStatus.READ,
        watermark: Date,
    ): Promise<number> {
        const scopedId = contact.scopedId;
        if (!scopedId) return 0;
        const row = await this.prisma.channelContact.findUnique({
            where: { channelId_externalId: { channelId: channel.id, externalId: scopedId } },
            select: { id: true },
        });
        if (!row) return 0;
        const earlier =
            status === MessageStatus.READ
                ? [MessageStatus.SENT, MessageStatus.DELIVERED]
                : [MessageStatus.SENT];
        const { count } = await this.prisma.message.updateMany({
            where: {
                channelId: channel.id,
                contactId: row.id,
                direction: MessageDirection.OUTBOUND,
                status: { in: earlier },
                sentAt: { lte: watermark },
            },
            data: status === MessageStatus.READ ? { status, readAt: watermark } : { status, deliveredAt: watermark },
        });
        if (count) {
            const conversation = await this.prisma.conversation.findUnique({
                where: { channelId_contactId: { channelId: channel.id, contactId: row.id } },
                select: { id: true },
            });
            if (conversation) this.events.publish(channel.organizationId, { type: 'conversation.updated', conversationId: conversation.id });
        }
        return count;
    }

    /** A reaction from the customer (`side: customer`) or business on a message. */
    async applyReaction(channel: IngestChannel, targetExternalId: string, emoji: string | null, side: 'customer' | 'business') {
        const target = await this.prisma.message.findFirst({
            where: { channelId: channel.id, externalId: targetExternalId },
            select: { id: true, reactions: true, conversationId: true },
        });
        if (!target) return false;
        const reactions = { ...((target.reactions as Record<string, string | null> | null) ?? {}), [side]: emoji };
        await this.prisma.message.update({ where: { id: target.id }, data: { reactions } });
        if (target.conversationId) {
            this.events.publish(channel.organizationId, { type: 'message.updated', conversationId: target.conversationId, messageId: target.id });
        }
        return true;
    }

    async applyEdit(channel: IngestChannel, externalId: string, text: string | null, at: Date) {
        const message = await this.prisma.message.findFirst({
            where: { channelId: channel.id, externalId },
            select: { id: true, conversationId: true, text: true, body: true },
        });
        if (!message) return false;
        const body = (message.body as Record<string, unknown>) ?? {};
        const edits = Array.isArray(body.edits) ? body.edits : [];
        await this.prisma.message.update({
            where: { id: message.id },
            data: {
                text,
                editedAt: at,
                body: { ...body, edits: [...edits, { previousText: message.text, at: at.toISOString() }] } as Prisma.InputJsonValue,
            },
        });
        if (message.conversationId) {
            this.events.publish(channel.organizationId, { type: 'message.updated', conversationId: message.conversationId, messageId: message.id });
        }
        return true;
    }

    /**
     * The author deleted the message. Its content is erased here too — Meta's
     * terms require deleting messages a user unsends — leaving a "deleted"
     * marker in the thread.
     */
    async applyRevoke(channel: IngestChannel, externalId: string, at: Date) {
        const message = await this.prisma.message.findFirst({
            where: { channelId: channel.id, externalId },
            select: { id: true, conversationId: true },
        });
        if (!message) return false;
        await this.prisma.message.update({
            where: { id: message.id },
            data: { revokedAt: at, text: null, media: Prisma.DbNull, body: { revoked: true } },
        });
        if (message.conversationId) {
            this.events.publish(channel.organizationId, { type: 'message.updated', conversationId: message.conversationId, messageId: message.id });
        }
        return true;
    }

    /** History media arrives after the chunk that announced it; fill the placeholder in. */
    async applyLateMedia(channel: IngestChannel, externalId: string, content: MessageContent) {
        const message = await this.prisma.message.findFirst({
            where: { channelId: channel.id, externalId },
            select: { id: true },
        });
        if (!message) return false;
        await this.prisma.message.update({
            where: { id: message.id },
            data: {
                kind: content.kind,
                text: content.text,
                media: (content.media ?? undefined) as Prisma.InputJsonValue | undefined,
            },
        });
        await this.queueMediaDownload(message.id, content.media);
        return true;
    }

    /** A number or BSUID change: keep the same contact under its new identity. */
    async rekeyContact(channel: IngestChannel, change: { previousUserId: string | null; userId: string | null; waId: string | null }) {
        return this.prisma.$transaction((tx) => this.identity.rekey(tx, channel.id, change));
    }

    /** Address-book contacts from the WhatsApp Business app (coexistence). */
    async applyAddressBook(
        channel: IngestChannel,
        entries: Array<{ action: string; name: string | null; contact: ContactRef }>,
    ): Promise<number> {
        let applied = 0;
        for (const entry of entries) {
            await this.prisma.$transaction(async (tx) => {
                const contact = await this.identity.resolve(tx, channel, entry.contact, { kind: 'none' });
                await tx.channelContact.update({
                    where: { id: contact.id },
                    data: {
                        addressBookName: entry.action === 'remove' ? null : entry.name,
                        ...(entry.action !== 'remove' && entry.name && !contact.displayName ? { displayName: entry.name } : {}),
                    },
                });
                await this.identity.linkCustomerByPhone(tx, contact);
            });
            applied++;
        }
        return applied;
    }

    /** Meta's marketing preference webhook: the customer stopped or resumed marketing. */
    async applyMarketingPreference(channel: IngestChannel, contactRef: ContactRef, value: string | null, at: Date) {
        if (value !== 'stop' && value !== 'resume') return;
        await this.prisma.$transaction(async (tx) => {
            const contact = await this.identity.resolve(tx, channel, contactRef, { kind: 'none' });
            await this.consent.record(
                tx,
                contact,
                value === 'stop' ? ConsentType.OPT_OUT : ConsentType.OPT_IN,
                'meta_preference',
                { value },
                null,
                at,
            );
        });
    }

    private async upsertConversation(
        tx: Prisma.TransactionClient,
        channel: IngestChannel,
        contactId: string,
        customerId: string | null,
        opts: {
            at: Date;
            preview: string;
            inbound: boolean;
            live: boolean;
            opensWindow: boolean;
            reopen: boolean;
            businessReply?: boolean;
        },
    ) {
        const existing = await tx.conversation.findUnique({
            where: { channelId_contactId: { channelId: channel.id, contactId } },
        });
        // Imported history is older than anything live: it never moves the
        // conversation's "last message" backwards.
        const isNewest = !existing?.lastMessageAt || opts.at >= existing.lastMessageAt;

        if (!existing) {
            try {
                const created = await tx.conversation.create({
                    data: {
                        organizationId: channel.organizationId,
                        channelId: channel.id,
                        contactId,
                        platform: channel.platform,
                        customerId,
                        lastMessageAt: opts.at,
                        lastMessagePreview: opts.preview,
                        messageCount: 1,
                        unreadCount: opts.inbound && opts.live ? 1 : 0,
                        ...(opts.opensWindow ? { lastInboundAt: opts.at } : {}),
                        ...(opts.inbound && opts.live ? { awaitingReplySince: opts.at } : {}),
                        ...(!opts.inbound && opts.live ? { lastOutboundAt: opts.at } : {}),
                        // A thread that only exists as imported history starts closed.
                        status: opts.live ? ConversationStatus.OPEN : ConversationStatus.CLOSED,
                        ...(opts.live && opts.inbound ? { openedAt: opts.at } : {}),
                    },
                });
                return Object.assign(created, { started: opts.live && opts.inbound });
            } catch (err) {
                if (!isUniqueViolation(err)) throw err;
                return this.upsertConversation(tx, channel, contactId, customerId, opts);
            }
        }

        const reopen =
            opts.reopen &&
            (existing.status === ConversationStatus.CLOSED || existing.status === ConversationStatus.SNOOZED);
        const updated = await tx.conversation.update({
            where: { id: existing.id },
            data: {
                messageCount: { increment: 1 },
                ...(customerId && !existing.customerId ? { customerId } : {}),
                ...(isNewest ? { lastMessageAt: opts.at, lastMessagePreview: opts.preview } : {}),
                ...(opts.inbound && opts.live ? { unreadCount: { increment: 1 } } : {}),
                ...(opts.opensWindow ? { lastInboundAt: opts.at } : {}),
                ...(opts.inbound && opts.live && !existing.awaitingReplySince ? { awaitingReplySince: opts.at } : {}),
                ...(!opts.inbound && opts.live ? { lastOutboundAt: opts.at } : {}),
                ...(opts.businessReply
                    ? { awaitingReplySince: null, ...(existing.firstResponseAt ? {} : { firstResponseAt: opts.at }) }
                    : {}),
                ...(reopen
                    ? { status: ConversationStatus.OPEN, snoozedUntil: null, closedAt: null, closedById: null, ...(existing.status === ConversationStatus.CLOSED ? { openedAt: opts.at } : {}) }
                    : {}),
            },
        });
        return Object.assign(updated, { started: reopen });
    }

    private findByExternalId(tx: Prisma.TransactionClient, channelId: string, externalId?: string | null) {
        if (!externalId) return Promise.resolve(null);
        return tx.message.findFirst({ where: { channelId, externalId }, select: { id: true } });
    }

    private async bumpDailyStat(
        tx: Prisma.TransactionClient | PrismaService,
        organizationId: string,
        contactId: string,
        at: Date,
        field: 'inboundCount' | 'deliveredCount' | 'failedCount' | 'sentCount',
    ) {
        const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
        await tx.contactDailyStat.upsert({
            where: { contactId_date: { contactId, date } },
            create: { organizationId, contactId, date, [field]: 1 },
            update: { [field]: { increment: 1 } },
        });
    }

    private async queueMediaDownload(messageId: string, media: MediaSpec | null) {
        if (!media || media.doNotStore || (!media.platformMediaId && !media.url)) return;
        await this.mediaQueue
            .add('download', { messageId }, { ...MEDIA_DOWNLOAD_JOB_OPTS, jobId: `media-${messageId}` })
            .catch((err) => this.logger.warn(`Could not queue media download for ${messageId}: ${err}`));
    }
}
