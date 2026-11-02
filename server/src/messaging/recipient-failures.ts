import { Prisma } from '@prisma/client';

/** Failed sends in a row, each the person's doing, that pause automations to them. */
export const FAILURES_BEFORE_PAUSE = 3;
/** How long automations leave the person alone once paused. */
export const FAILURE_PAUSE_MS = 24 * 3600_000;

type ContactWriter = Pick<Prisma.TransactionClient, 'channelContact'>;

/**
 * A send that failed because of the person, not the account: they blocked the
 * business, deleted their account or cannot receive messages. Codes are Meta's:
 * WhatsApp 131026 (undeliverable), and the Messenger Platform list Instagram
 * shares: 551 (blocked / not available), 200·1545041 (not available),
 * 10·2018108 (cannot receive right now), 100·2018001 and 100·2534014 (no
 * matching user). A token, payment, template or rate-limit refusal is the
 * account's problem and never counts against the person.
 */
export function isRecipientFailure(code: number | undefined, subcode?: number): boolean {
    switch (code) {
        case 131026:
        case 551:
            return true;
        case 200:
            return subcode === 1545041;
        case 10:
            return subcode === 2018108;
        case 100:
            return subcode === 2018001 || subcode === 2534014;
        default:
            return false;
    }
}

/** One more failure in a row; the one that reaches the limit pauses automations to the person, and so does each after it. */
export async function noteRecipientFailure(db: ContactWriter, contactId: string, at: Date): Promise<void> {
    const { consecutiveFailures } = await db.channelContact.update({
        where: { id: contactId },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true },
    });
    if (consecutiveFailures >= FAILURES_BEFORE_PAUSE) {
        await db.channelContact.update({ where: { id: contactId }, data: { mutedUntil: new Date(at.getTime() + FAILURE_PAUSE_MS) } });
    }
}

/** The person was reached, or wrote in: earlier failures no longer count, and a pause ends. */
export async function clearRecipientFailures(db: ContactWriter, contactId: string): Promise<void> {
    await db.channelContact.updateMany({
        where: { id: contactId, OR: [{ consecutiveFailures: { gt: 0 } }, { mutedUntil: { not: null } }] },
        data: { consecutiveFailures: 0, mutedUntil: null },
    });
}
