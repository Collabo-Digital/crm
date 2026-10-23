import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
    | 'facebook.postback'
    /** A tag was added to a contact, by a person, an import or an automation. */
    | 'crm.contact.tag_added'
    /** Another system called an automation's webhook URL. */
    | 'crm.webhook'
    /** A cart sent from the WhatsApp catalog. */
    | 'whatsapp.cart';

/** Tags added by automations can start automations that add tags; stop after this many hops. */
export const MAX_TAG_DEPTH = 3;

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

    /**
     * One tag_added event per tag that is new on the contact. Returns the event
     * ids for the caller to queue once its transaction commits.
     */
    async recordTagsAdded(
        tx: Prisma.TransactionClient,
        contact: { id: string; organizationId: string; channelId: string; externalId: string },
        tags: string[],
        depth = 0,
    ): Promise<string[]> {
        if (depth > MAX_TAG_DEPTH) return [];
        const ids: string[] = [];
        for (const tag of tags) {
            const row = await this.record(tx, {
                organizationId: contact.organizationId,
                channelId: contact.channelId,
                eventType: 'crm.contact.tag_added',
                externalId: `${contact.id}:${tag}:${randomUUID()}`,
                occurredAt: new Date(),
                contactId: contact.id,
                actorExternalId: contact.externalId,
                text: tag,
                payload: { tag, depth },
            });
            ids.push(row.id);
        }
        return ids;
    }
}
