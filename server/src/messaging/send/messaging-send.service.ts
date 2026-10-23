import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MessageDirection, MessageKind, MessageSource, MessageStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ChannelAccessService } from '../channel-access.service';
import { InboxEventsService } from '../inbox-events.service';
import { previewOf } from '../message-content';
import {
    OutboundPayload,
    SendOrigin,
    SendRefusal,
    checkSend,
    outboundText,
    replyWindow,
} from '../outbound';
import { MESSAGING_OUTBOUND_QUEUE, ORIGIN_PRIORITY, OUTBOUND_JOB_OPTS, OutboundJobData } from './outbound.queue';

export interface SendInput {
    organizationId: string;
    conversationId: string;
    payload: OutboundPayload;
    origin: SendOrigin;
    actorUserId?: string | null;
    /** Our message row being quoted. */
    replyToMessageId?: string | null;
    automation?: { automationId: string; runId: string; stepKey: string } | null;
    /** Same key twice sends once. */
    idempotencyKey?: string | null;
}

export type SendOutcome =
    | { ok: true; messageId: string; duplicate?: boolean }
    | { ok: false; code: SendRefusal; message: string };

const SOURCE_BY_ORIGIN: Record<SendOrigin, MessageSource> = {
    agent: MessageSource.AGENT,
    automation: MessageSource.AUTOMATION,
    broadcast: MessageSource.BROADCAST,
    system: MessageSource.SYSTEM,
    api: MessageSource.API,
};

function kindOf(payload: OutboundPayload): MessageKind {
    switch (payload.type) {
        case 'text':
            return MessageKind.TEXT;
        case 'media':
            return ({ image: MessageKind.IMAGE, video: MessageKind.VIDEO, audio: MessageKind.AUDIO, document: MessageKind.DOCUMENT } as const)[payload.mediaKind];
        case 'template':
            return MessageKind.TEMPLATE;
        case 'location':
            return MessageKind.LOCATION;
        case 'reaction':
            return MessageKind.REACTION;
        case 'private_reply':
            return MessageKind.PRIVATE_REPLY;
        case 'comment_reply':
            return MessageKind.COMMENT;
        case 'product':
        case 'product_list':
        case 'catalog':
            return MessageKind.PRODUCT;
        default:
            return MessageKind.INTERACTIVE;
    }
}

/**
 * The one way anything leaves Collabo as a message: the inbox, automations,
 * broadcasts and order notifications all call `send`. It applies the rules
 * (window, consent, channel health), writes a QUEUED row so the thread shows
 * the message at once, and queues delivery.
 */
@Injectable()
export class MessagingSendService {
    private readonly logger = new Logger(MessagingSendService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ChannelAccessService,
        private readonly events: InboxEventsService,
        @InjectQueue(MESSAGING_OUTBOUND_QUEUE) private readonly queue: Queue<OutboundJobData>,
    ) { }

    async send(input: SendInput): Promise<SendOutcome> {
        if (input.idempotencyKey) {
            const prior = await this.prisma.message.findUnique({
                where: { idempotencyKey: input.idempotencyKey },
                select: { id: true },
            });
            if (prior) return { ok: true, messageId: prior.id, duplicate: true };
        }

        const conversation = await this.prisma.conversation.findFirst({
            where: { id: input.conversationId, organizationId: input.organizationId },
            include: { contact: true },
        });
        if (!conversation) throw new NotFoundException('Conversation not found');

        const fileKey =
            input.payload.type === 'media'
                ? input.payload.storageKey
                : input.payload.type === 'template'
                    ? input.payload.headerMedia?.storageKey
                    : undefined;
        if (fileKey !== undefined && !fileKey.startsWith(`${input.organizationId}/`)) {
            throw new BadRequestException('Upload the file again before sending it.');
        }

        const channel = await this.access.get(conversation.channelId);
        const gate = checkSend({
            platform: conversation.platform,
            payload: input.payload,
            origin: input.origin,
            channel: { status: channel.status, isEnabled: channel.isEnabled, sendsPaused: channel.sendsPaused, onBusinessApp: channel.onBusinessApp },
            contact: { blockedAt: conversation.contact.blockedAt, optedOutAt: conversation.contact.optedOutAt },
            window: replyWindow(conversation.platform, conversation.lastInboundAt),
        });
        if (!gate.ok) return gate;

        const replyTo = input.replyToMessageId
            ? await this.prisma.message.findFirst({
                where: { id: input.replyToMessageId, conversationId: conversation.id },
                select: { id: true, externalId: true },
            })
            : null;

        const now = new Date();
        const text = outboundText(input.payload);
        const kind = kindOf(input.payload);
        const preview = previewOf({ kind, text, media: input.payload.type === 'media' ? {} : null });

        let messageId: string;
        try {
            messageId = await this.prisma.$transaction(async (tx) => {
                const message = await tx.message.create({
                    data: {
                        organizationId: input.organizationId,
                        channelId: conversation.channelId,
                        platform: conversation.platform,
                        direction: MessageDirection.OUTBOUND,
                        kind,
                        source: SOURCE_BY_ORIGIN[input.origin],
                        sentByUserId: input.actorUserId ?? null,
                        conversationId: conversation.id,
                        contactId: conversation.contactId,
                        customerId: conversation.customerId,
                        toAddress: conversation.contact.externalId,
                        fromAddress: channel.address,
                        text,
                        templateName: input.payload.type === 'template' ? input.payload.name : null,
                        templateLanguage: input.payload.type === 'template' ? input.payload.language : null,
                        inReplyToExternalId:
                            input.payload.type === 'private_reply' || input.payload.type === 'comment_reply' ? input.payload.commentId : null,
                        replyToMessageId: replyTo?.id ?? null,
                        replyToExternalId: replyTo?.externalId ?? null,
                        body: { payload: input.payload, humanAgentTag: gate.humanAgentTag } as unknown as Prisma.InputJsonValue,
                        media:
                            input.payload.type === 'media'
                                ? ({
                                    storageKey: input.payload.storageKey,
                                    mime: input.payload.mime,
                                    filename: input.payload.filename,
                                } as Prisma.InputJsonValue)
                                : undefined,
                        status: MessageStatus.QUEUED,
                        automationId: input.automation?.automationId ?? null,
                        automationRunId: input.automation?.runId ?? null,
                        stepKey: input.automation?.stepKey ?? null,
                        idempotencyKey: input.idempotencyKey ?? null,
                    },
                    select: { id: true },
                });
                if (input.payload.type !== 'reaction') {
                    await tx.conversation.update({
                        where: { id: conversation.id },
                        data: {
                            lastMessageAt: now,
                            lastMessagePreview: preview,
                            lastOutboundAt: now,
                            messageCount: { increment: 1 },
                            ...(input.origin === 'agent' || input.origin === 'automation'
                                ? {
                                    awaitingReplySince: null,
                                    ...(conversation.firstResponseAt ? {} : { firstResponseAt: now }),
                                    ...(input.origin === 'agent' ? { lastAgentReplyAt: now } : {}),
                                }
                                : {}),
                        },
                    });
                    await tx.channelContact.update({
                        where: { id: conversation.contactId },
                        data: { lastOutboundAt: now, outboundCount: { increment: 1 } },
                    });
                }
                return message.id;
            });
        } catch (err) {
            if (input.idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                const prior = await this.prisma.message.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
                if (prior) return { ok: true, messageId: prior.id, duplicate: true };
            }
            throw err;
        }

        await this.queue.add(
            'deliver',
            { kind: 'deliver', messageId, humanAgentTag: gate.humanAgentTag },
            { ...OUTBOUND_JOB_OPTS, jobId: `deliver-${messageId}`, priority: ORIGIN_PRIORITY[input.origin] },
        );
        this.events.publish(input.organizationId, { type: 'message.created', conversationId: conversation.id, messageId });
        this.events.publish(input.organizationId, { type: 'conversation.updated', conversationId: conversation.id });
        return { ok: true, messageId };
    }

    /**
     * The conversation to send a broadcast or automation message in. A new
     * one starts closed: an outbound message alone is not work for the
     * inbox, and the customer's reply opens it.
     */
    async conversationFor(contactId: string): Promise<string> {
        const contact = await this.prisma.channelContact.findUniqueOrThrow({
            where: { id: contactId },
            select: { id: true, organizationId: true, channelId: true, platform: true, customerId: true },
        });
        const existing = await this.prisma.conversation.findUnique({
            where: { channelId_contactId: { channelId: contact.channelId, contactId: contact.id } },
            select: { id: true },
        });
        if (existing) return existing.id;
        try {
            const created = await this.prisma.conversation.create({
                data: {
                    organizationId: contact.organizationId,
                    channelId: contact.channelId,
                    contactId: contact.id,
                    platform: contact.platform,
                    customerId: contact.customerId,
                    status: 'CLOSED',
                    closedAt: new Date(),
                },
                select: { id: true },
            });
            return created.id;
        } catch (err) {
            if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
            const winner = await this.prisma.conversation.findUniqueOrThrow({
                where: { channelId_contactId: { channelId: contact.channelId, contactId: contact.id } },
                select: { id: true },
            });
            return winner.id;
        }
    }

    /** Send blue ticks / "seen" for the customer's latest message. Best-effort. */
    async markRead(conversationId: string): Promise<void> {
        const conversation = await this.prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { channelId: true, contact: { select: { externalId: true } } },
        });
        if (!conversation) return;
        const latest = await this.prisma.message.findFirst({
            where: { conversationId, direction: MessageDirection.INBOUND, imported: false, externalId: { not: null } },
            orderBy: { createdAt: 'desc' },
            select: { externalId: true },
        });
        await this.queue
            .add(
                'mark-read',
                {
                    kind: 'mark-read',
                    channelId: conversation.channelId,
                    contactExternalId: conversation.contact.externalId,
                    messageExternalId: latest?.externalId ?? null,
                },
                { attempts: 2, removeOnComplete: true, removeOnFail: { count: 200 }, priority: ORIGIN_PRIORITY.agent },
            )
            .catch((err) => this.logger.warn(`Read receipt not queued: ${err}`));
    }
}
