import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** Who a broadcast goes to, and who it leaves out. */
export const BroadcastAudienceSchema = z.object({
    /** Everyone on the WhatsApp number. Otherwise the segments and tags below, combined. */
    everyone: z.boolean().default(false),
    segmentIds: z.array(z.string().max(40)).max(20).default([]),
    tags: z.array(z.string().min(1).max(60)).max(20).default([]),
    exclude: z
        .object({
            segmentIds: z.array(z.string().max(40)).max(20).default([]),
            tags: z.array(z.string().min(1).max(60)).max(20).default([]),
            /** People who already received these broadcasts. */
            broadcastIds: z.array(z.string().max(40)).max(20).default([]),
            /** People sent any broadcast in this many hours. */
            messagedWithinHours: z.number().int().min(1).max(720).nullable().default(null),
        })
        .default({ segmentIds: [], tags: [], broadcastIds: [], messagedWithinHours: null }),
    /** Only people with a recorded opt-in. */
    requireOptIn: z.boolean().default(false),
});

export type BroadcastAudience = z.infer<typeof BroadcastAudienceSchema>;

export function parseAudience(raw: unknown): BroadcastAudience {
    const parsed = BroadcastAudienceSchema.safeParse(raw ?? {});
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException(`Invalid audience: ${issue.path.join('.') || 'audience'} — ${issue.message}`);
    }
    return parsed.data;
}

export function isEmptyAudience(a: BroadcastAudience): boolean {
    return !a.everyone && a.segmentIds.length === 0 && a.tags.length === 0;
}

export type SkipReason =
    | 'blocked'
    | 'opted_out'
    | 'no_opt_in'
    | 'no_whatsapp_id'
    | 'excluded'
    | 'already_received'
    | 'recently_messaged';

export const SKIP_REASON_LABEL: Record<SkipReason | 'missing_value', string> = {
    blocked: 'Blocked',
    opted_out: 'Opted out of marketing',
    no_opt_in: 'No recorded opt-in',
    no_whatsapp_id: 'No WhatsApp number or user id',
    excluded: 'In an excluded segment or tag',
    already_received: 'Already received an excluded broadcast',
    recently_messaged: 'Sent a broadcast recently',
    missing_value: 'Missing a template value',
};

/** What decides whether one included contact is left out. */
export interface AudienceMember {
    blockedAt: Date | null;
    optedOutAt: Date | null;
    optInAt: Date | null;
    waId: string | null;
    externalId: string;
    excluded: boolean;
    alreadyReceived: boolean;
    recentlyMessaged: boolean;
}

/**
 * Why a contact is left out, or null to send. Opting out of marketing does
 * not stop a utility template; being blocked stops everything.
 */
export function skipReason(m: AudienceMember, opts: { marketing: boolean; requireOptIn: boolean }): SkipReason | null {
    if (m.blockedAt) return 'blocked';
    if (opts.marketing && m.optedOutAt) return 'opted_out';
    if (opts.requireOptIn && (!m.optInAt || m.optedOutAt)) return 'no_opt_in';
    if (!m.waId && !/^[A-Z]{2}\./.test(m.externalId)) return 'no_whatsapp_id';
    if (m.excluded) return 'excluded';
    if (m.alreadyReceived) return 'already_received';
    if (m.recentlyMessaged) return 'recently_messaged';
    return null;
}

/**
 * Longest calling-code prefix with a rate, else the "*" row. Digits only;
 * BSUID-only recipients (no number) fall to "*".
 */
export function rateFor<T extends { countryPrefix: string }>(digits: string | null, rates: T[]): T | null {
    const sorted = [...rates].filter((r) => r.countryPrefix !== '*').sort((a, b) => b.countryPrefix.length - a.countryPrefix.length);
    if (digits) {
        const hit = sorted.find((r) => digits.startsWith(r.countryPrefix));
        if (hit) return hit;
    }
    return rates.find((r) => r.countryPrefix === '*') ?? null;
}
