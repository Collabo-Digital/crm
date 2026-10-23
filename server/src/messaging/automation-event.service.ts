import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Events that can start an automation. Namespaced strings, validated here
 * rather than in the database, as the automation schema intends.
 */
export type InboundEventType =
    | 'whatsapp.message'
    | 'instagram.message'
    | 'facebook.message'
    | 'instagram.comment'
    | 'facebook.comment'
    | 'instagram.mention'
    | 'instagram.postback'
    | 'facebook.postback';

export interface RecordEventInput {
    organizationId: string;
    channelId: string;
    eventType: InboundEventType;
    /** Comment id, message id or wamid. Dedupe key with organizationId + eventType. */
    externalId: string;
    occurredAt: Date;
    contactId: string;
    /** The INBOUND Message row the event was raised from. */
    messageId?: string;
    /** Instagram media id for comments and mentions; resolved to channel_media when cached. */
    mediaExternalId?: string;
    actorExternalId: string;
    actorUsername?: string;
    text?: string;
    payload: unknown;
}

/**
 * The visitor log: one row per thing that could start an automation. Written
 * in the same transaction as the message it came from; the engine picks
 * unprocessed rows up from here.
 */
@Injectable()
export class AutomationEventService {

    findByKey(
        tx: Prisma.TransactionClient,
        organizationId: string,
        eventType: InboundEventType,
        externalId: string,
    ) {
        return tx.automationEvent.findUnique({
            where: { organizationId_eventType_externalId: { organizationId, eventType, externalId } },
            select: { id: true },
        });
    }

    async record(tx: Prisma.TransactionClient, input: RecordEventInput) {
        let mediaId: string | null = null;
        if (input.mediaExternalId) {
            const media = await tx.channelMedia.findUnique({
                where: {
                    channelId_externalId: {
                        channelId: input.channelId,
                        externalId: input.mediaExternalId,
                    },
                },
                select: { id: true },
            });
            mediaId = media?.id ?? null;
        }

        return tx.automationEvent.create({
            data: {
                organizationId: input.organizationId,
                channelId: input.channelId,
                eventType: input.eventType,
                externalId: input.externalId,
                occurredAt: input.occurredAt,
                contactId: input.contactId,
                messageId: input.messageId ?? null,
                mediaId,
                actorExternalId: input.actorExternalId,
                actorUsername: input.actorUsername ?? null,
                text: input.text ?? null,
                payload: {
                    mediaExternalId: input.mediaExternalId ?? null,
                    raw: input.payload,
                } as Prisma.InputJsonValue,
            },
        });
    }
}