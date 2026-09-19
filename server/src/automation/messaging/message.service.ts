import { Injectable } from '@nestjs/common';
import {
    ChannelPlatform,
    MessageDirection,
    MessageKind,
    MessageStatus,
    Prisma,
} from '@prisma/client';

export interface RecordInboundInput {
    organizationId: string;
    channelId: string;
    platform: ChannelPlatform;
    contactId: string;
    /** Our own account id (the channel's external_store_id). */
    toAddress: string;
    /** The sender's IGSID. */
    fromAddress: string;
    /** Instagram message id (mid). Dedupe key with channelId. */
    externalId: string;
    text?: string;
    kind: MessageKind;
    /** The raw webhook messaging object. */
    body: unknown;
    occurredAt: Date;
}

const PREVIEW_LENGTH = 140;

/** UTC midnight for a @db.Date column. */
function dayOf(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * The letters: inbound rows only for now. Outbound (createOutbound / markSent /
 * markFailed) arrives with the send step.
 */
@Injectable()
export class MessageService {

    /** The redelivery check for DMs; the partial unique index is the race fallback. */
    findInboundByExternalId(tx: Prisma.TransactionClient, channelId: string, externalId: string) {
        return tx.message.findFirst({
            where: { channelId, externalId, direction: MessageDirection.INBOUND },
            select: { id: true },
        });
    }

    async recordInbound(tx: Prisma.TransactionClient, input: RecordInboundInput) {
        const preview = (input.text ?? '').trim().slice(0, PREVIEW_LENGTH) || null;

        const conversation = await tx.conversation.upsert({
            where: {
                channelId_contactId: { channelId: input.channelId, contactId: input.contactId },
            },
            create: {
                organizationId: input.organizationId,
                channelId: input.channelId,
                contactId: input.contactId,
                platform: input.platform,
                lastMessageAt: input.occurredAt,
                lastInboundAt: input.occurredAt,
                lastMessagePreview: preview,
                unreadCount: 1,
                messageCount: 1,
            },
            update: {
                lastMessageAt: input.occurredAt,
                lastInboundAt: input.occurredAt,
                lastMessagePreview: preview,
                unreadCount: { increment: 1 },
                messageCount: { increment: 1 },
            },
        });

        const message = await tx.message.create({
            data: {
                organizationId: input.organizationId,
                channelId: input.channelId,
                platform: input.platform,
                direction: MessageDirection.INBOUND,
                kind: input.kind,
                conversationId: conversation.id,
                contactId: input.contactId,
                toAddress: input.toAddress,
                fromAddress: input.fromAddress,
                text: input.text ?? null,
                body: input.body as Prisma.InputJsonValue,
                status: MessageStatus.DELIVERED,
                externalId: input.externalId,
                deliveredAt: input.occurredAt,
            },
        });

        const date = dayOf(input.occurredAt);
        await tx.contactDailyStat.upsert({
            where: { contactId_date: { contactId: input.contactId, date } },
            create: {
                organizationId: input.organizationId,
                contactId: input.contactId,
                date,
                inboundCount: 1,
            },
            update: { inboundCount: { increment: 1 } },
        });

        return message;
    }
}