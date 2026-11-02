import { Injectable, Logger } from '@nestjs/common';
import { ChannelContact, ChannelPlatform, Prisma } from '@prisma/client';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * SQL: is the phone stored in `column` (as typed, in any format) the number
 * `digits` (with its country code)? The last ten digits must match, and in
 * front of them may stand only the rest of the national number, alone (with
 * or without a trunk 0), after the country code, or after the country code
 * and a trunk 0 ("+44 (0)7911 123456"). So +44 7911 123456 never matches a
 * number saved as +91 79111 23456.
 */
export function storedPhoneIs(column: Prisma.Sql, digits: string): Prisma.Sql {
    // National numbers longer than ten digits (Brazilian, German, Chinese mobiles) keep their first digits.
    const p = /^(521|549)\d{10}$/.test(digits) ? undefined : parsePhoneNumberFromString(`+${digits}`);
    const long = !!p?.isValid() && p.number === `+${digits}` && p.nationalNumber.length > 10 && !p.nationalNumber.startsWith('0');
    const cc = long ? p!.countryCallingCode : digits.slice(0, -10);
    const rest = long ? p!.nationalNumber.slice(0, -10) : '';
    const before = [rest, `${cc}${rest}`, `${cc}0${rest}`];
    // WhatsApp writes Mexican and Argentine mobiles as 521… and 549…; stores usually save them without the 1 or 9.
    if (/^521\d{10}$/.test(digits)) before.push('52');
    if (/^549\d{10}$/.test(digits)) before.push('54');
    const stored = Prisma.sql`regexp_replace(${column}, '\\D', '', 'g')`;
    return Prisma.sql`(right(${stored}, 10) = ${digits.slice(-10)} AND ltrim(left(${stored}, -10), '0') IN (${Prisma.join(before)}))`;
}

/** Who a message is from (or to), as the platform identified them. */
export interface ContactRef {
    platform: ChannelPlatform;
    /** WhatsApp business-scoped user id. */
    userId?: string | null;
    /** WhatsApp phone number digits. */
    waId?: string | null;
    /** Messenger PSID / Instagram IGSID. */
    scopedId?: string | null;
    username?: string | null;
    profileName?: string | null;
}

export interface ChannelScope {
    id: string;
    organizationId: string;
}

/** What this contact did, for the window and counter columns. */
export type ContactTouch = { kind: 'message' | 'comment'; at: Date } | { kind: 'none' };

/**
 * The key a contact is filed under. WhatsApp prefers the BSUID: users who
 * adopt a username stop sending their phone number, and the BSUID is on every
 * webhook since April 2026. The phone number is the fallback for a payload
 * that carries nothing else.
 */
export function contactKey(ref: ContactRef): string | null {
    if (ref.platform === ChannelPlatform.WHATSAPP) return ref.userId ?? ref.waId ?? null;
    return ref.scopedId ?? null;
}

const isUniqueViolation = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/// A customer added since is linked on the first message after this.
const UNMATCHED_TTL_MS = 10 * 60_000;
const UNMATCHED_MAX = 20_000;

/**
 * Finds or creates the ChannelContact for a platform identity, keeping
 * WhatsApp contacts stable across the identity changes Meta now makes: a
 * contact first seen by phone number is re-keyed to its BSUID when one
 * arrives, and a number or BSUID change moves the old id to
 * `previousExternalIds` instead of starting a new contact.
 */
@Injectable()
export class ContactIdentityService {
    private readonly logger = new Logger(ContactIdentityService.name);
    /** "org:waId" of numbers that matched no single customer, with when; oldest first. */
    private readonly unmatched = new Map<string, number>();

    async resolve(
        tx: Prisma.TransactionClient,
        channel: ChannelScope,
        ref: ContactRef,
        touch: ContactTouch,
    ): Promise<ChannelContact> {
        const key = contactKey(ref);
        if (!key) throw new Error(`No usable identity for a ${ref.platform} contact`);

        let contact = await tx.channelContact.findUnique({
            where: { channelId_externalId: { channelId: channel.id, externalId: key } },
        });
        // A delivery still carrying an id the contact has since moved away from.
        contact ??= await tx.channelContact.findFirst({
            where: { channelId: channel.id, previousExternalIds: { has: key } },
        });

        // Known by phone number before the BSUID arrived: adopt the BSUID.
        if (!contact && ref.platform === ChannelPlatform.WHATSAPP && ref.waId) {
            const byPhone = await tx.channelContact.findFirst({
                where: { channelId: channel.id, OR: [{ waId: ref.waId }, { externalId: ref.waId }] },
            });
            if (byPhone) {
                contact = await tx.channelContact.update({
                    where: { id: byPhone.id },
                    data: {
                        externalId: key,
                        previousExternalIds:
                            byPhone.externalId === key
                                ? undefined
                                : { set: [...new Set([...byPhone.previousExternalIds, byPhone.externalId])] },
                    },
                });
            }
        }

        const touchData =
            touch.kind === 'message'
                ? { lastInboundMessageAt: touch.at, inboundCount: { increment: 1 } }
                : touch.kind === 'comment'
                    ? { lastCommentAt: touch.at }
                    : {};
        const profile = {
            ...(ref.waId ? { waId: ref.waId, phone: `+${ref.waId}` } : {}),
            ...(ref.username ? { username: ref.username } : {}),
            ...(ref.profileName ? { displayName: ref.profileName } : {}),
        };

        if (contact) {
            return tx.channelContact.update({ where: { id: contact.id }, data: { ...profile, ...touchData } });
        }

        try {
            return await tx.channelContact.create({
                data: {
                    organizationId: channel.organizationId,
                    channelId: channel.id,
                    platform: ref.platform,
                    externalId: key,
                    ...profile,
                    ...(touch.kind === 'message'
                        ? { lastInboundMessageAt: touch.at, inboundCount: 1 }
                        : touch.kind === 'comment'
                            ? { lastCommentAt: touch.at }
                            : {}),
                },
            });
        } catch (err) {
            // Two deliveries raced to create the same person: use the winner.
            if (!isUniqueViolation(err)) throw err;
            const winner = await tx.channelContact.findUniqueOrThrow({
                where: { channelId_externalId: { channelId: channel.id, externalId: key } },
            });
            return tx.channelContact.update({ where: { id: winner.id }, data: { ...profile, ...touchData } });
        }
    }

    /**
     * A `user_changed_number` / `user_changed_user_id` system message: move the
     * contact to its new identity so the conversation carries on.
     */
    async rekey(
        tx: Prisma.TransactionClient,
        channelId: string,
        change: { previousUserId: string | null; userId: string | null; waId: string | null },
    ): Promise<ChannelContact | null> {
        if (!change.previousUserId || !change.userId) return null;
        const contact = await tx.channelContact.findUnique({
            where: { channelId_externalId: { channelId, externalId: change.previousUserId } },
        });
        if (!contact) return null;
        return tx.channelContact.update({
            where: { id: contact.id },
            data: {
                externalId: change.userId,
                previousExternalIds: { set: [...new Set([...contact.previousExternalIds, change.previousUserId])] },
                ...(change.waId ? { waId: change.waId, phone: `+${change.waId}` } : {}),
            },
        });
    }

    /**
     * Link a WhatsApp contact to the store customer with the same phone
     * number (see storedPhoneIs), when exactly one matches.
     *
     * The match scans the organization's customers (no index can serve it),
     * so a number that matched nobody is not looked up again for a while:
     * otherwise every message from it, and every item of a history import,
     * would repeat the scan.
     */
    async linkCustomerByPhone(tx: Prisma.TransactionClient, contact: ChannelContact, now = Date.now()): Promise<string | null> {
        if (contact.customerId || !contact.waId || contact.waId.length < 10) return contact.customerId;
        const key = `${contact.organizationId}:${contact.waId}`;
        const checkedAt = this.unmatched.get(key);
        if (checkedAt !== undefined && now - checkedAt < UNMATCHED_TTL_MS) return null;
        const matches = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "customers"
            WHERE "organization_id" = ${contact.organizationId}
              AND "deleted_at" IS NULL
              AND "phone" IS NOT NULL
              AND ${storedPhoneIs(Prisma.raw('"phone"'), contact.waId)}
            LIMIT 2
        `;
        if (matches.length !== 1) {
            this.unmatched.delete(key);
            if (this.unmatched.size >= UNMATCHED_MAX) this.unmatched.delete(this.unmatched.keys().next().value!);
            this.unmatched.set(key, now);
            return null;
        }
        await tx.channelContact.update({ where: { id: contact.id }, data: { customerId: matches[0].id } });
        await tx.conversation.updateMany({
            where: { contactId: contact.id, customerId: null },
            data: { customerId: matches[0].id },
        });
        return matches[0].id;
    }
}
