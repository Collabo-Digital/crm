import { Injectable } from '@nestjs/common';
import { ConsentType, Prisma } from '@prisma/client';

/** "STOP", "Unsubscribe", "stop promotions"... — a customer opting out in their own words. */
export function isOptOutText(text: string | null | undefined): boolean {
    if (!text) return false;
    return /^\s*(stop|unsubscribe|opt[\s-]?out|stop promotions|stop all)\s*[.!]?\s*$/i.test(text);
}

/** "START" or "Subscribe" — opting back in after a STOP. */
export function isOptInText(text: string | null | undefined): boolean {
    if (!text) return false;
    return /^\s*(start|subscribe|opt[\s-]?in|unstop)\s*[.!]?\s*$/i.test(text);
}

/**
 * Marketing consent: the current state on the contact, every change in
 * consent_events. Marketing templates check `optedOutAt`; service replies to
 * a customer who wrote in are never blocked by it.
 */
@Injectable()
export class ConsentService {
    async record(
        tx: Prisma.TransactionClient,
        contact: { id: string; organizationId: string },
        type: ConsentType,
        source: string,
        evidence: Record<string, unknown> | null,
        actorUserId?: string | null,
        at = new Date(),
    ): Promise<void> {
        await tx.consentEvent.create({
            data: {
                organizationId: contact.organizationId,
                contactId: contact.id,
                type,
                source,
                evidence: (evidence ?? undefined) as Prisma.InputJsonValue | undefined,
                actorUserId: actorUserId ?? null,
                occurredAt: at,
            },
        });
        await tx.channelContact.update({
            where: { id: contact.id },
            data:
                type === ConsentType.OPT_OUT
                    ? { optedOutAt: at, optOutSource: source }
                    : { optedOutAt: null, optOutSource: null, optInAt: at, optInSource: source },
        });
    }
}
