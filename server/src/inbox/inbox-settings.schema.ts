import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PLATFORMS = ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK'] as const;

const Day = z.object({
    /** 0 = Sunday … 6 = Saturday. */
    day: z.number().int().min(0).max(6),
    open: z.string().regex(HHMM),
    close: z.string().regex(HHMM),
});

const AutoReply = (defaults: { message: string; cooldownHours: number }) =>
    z
        .object({
            enabled: z.boolean().default(false),
            message: z.string().max(1000).default(defaults.message),
            platforms: z.array(z.enum(PLATFORMS)).default([...PLATFORMS]),
            /** At most one per person in this many hours. */
            cooldownHours: z.number().int().min(1).max(720).default(defaults.cooldownHours),
        })
        .default({ enabled: false, message: defaults.message, platforms: [...PLATFORMS], cooldownHours: defaults.cooldownHours });

const RoutingCondition = z.object({
    field: z.enum(['message', 'platform', 'channel', 'tag', 'customer']),
    /** message: contains · platform/channel: is · tag: has · customer: linked / vip. */
    op: z.enum(['contains', 'is', 'has', 'linked', 'vip']),
    value: z.string().max(200).default(''),
});

const Assignment = z.object({
    mode: z.enum(['user', 'team', 'round_robin']),
    userId: z.string().max(40).default(''),
    /** team: queue for the team · round_robin: spread across the team (or everyone when empty). */
    teamId: z.string().max(40).default(''),
});

export const InboxSettingsSchema = z.object({
    businessHours: z
        .object({
            enabled: z.boolean().default(false),
            /** IANA zone; empty uses the organization's. */
            timezone: z.string().max(60).default(''),
            days: z.array(Day).max(14).default([1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' }))),
        })
        .default({ enabled: false, timezone: '', days: [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' })) }),
    /** Sent when a new or reopened conversation starts during business hours. */
    welcome: AutoReply({ message: 'Hi {{first_name}}! Thanks for reaching out — someone from our team will reply shortly.', cooldownHours: 24 }),
    /** Sent when someone writes outside business hours. */
    away: AutoReply({ message: 'Hi {{first_name}}, we are away right now and will reply as soon as we are back.', cooldownHours: 12 }),
    routing: z
        .object({
            rules: z
                .array(
                    z.object({
                        id: z.string().max(40),
                        name: z.string().max(80),
                        match: z.enum(['all', 'any']).default('all'),
                        conditions: z.array(RoutingCondition).min(1).max(10),
                        assign: Assignment,
                    }),
                )
                .max(30)
                .default([]),
        })
        .default({ rules: [] }),
    /** Unassigned new conversations that no routing rule took. */
    roundRobin: z
        .object({
            enabled: z.boolean().default(false),
            /** Spread across this team; empty for every agent. */
            teamId: z.string().max(40).default(''),
            maxOpenPerAgent: z.number().int().min(1).max(500).default(25),
        })
        .default({ enabled: false, teamId: '', maxOpenPerAgent: 25 }),
    autoClose: z
        .object({
            enabled: z.boolean().default(false),
            afterHours: z.number().int().min(1).max(2160).default(72),
        })
        .default({ enabled: false, afterHours: 72 }),
    spam: z
        .object({
            /** Adding this tag closes the conversation and blocks the contact. */
            enabled: z.boolean().default(true),
            tag: z.string().min(1).max(60).default('spam'),
            /** Also block the number on WhatsApp (only possible within 24 hours of their last message). */
            blockOnWhatsApp: z.boolean().default(false),
        })
        .default({ enabled: true, tag: 'spam', blockOnWhatsApp: false }),
});

export type InboxSettings = z.infer<typeof InboxSettingsSchema>;
export type RoutingRule = InboxSettings['routing']['rules'][number];

export function parseInboxSettings(raw: unknown): InboxSettings {
    const parsed = InboxSettingsSchema.safeParse(raw ?? {});
    // Stored settings that no longer parse fall back to defaults rather than break the inbox.
    return parsed.success ? parsed.data : InboxSettingsSchema.parse({});
}

export function validateInboxSettings(raw: unknown): InboxSettings {
    const parsed = InboxSettingsSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException(`Invalid inbox settings: ${issue.path.join('.') || 'settings'} — ${issue.message}`);
    }
    for (const d of parsed.data.businessHours.days) {
        if (d.open >= d.close) throw new BadRequestException('Business hours: each day must close after it opens.');
    }
    return parsed.data;
}

/**
 * Whether the business is open at `now` in `timeZone`. With business hours
 * off, it always is: there is no "away" to be.
 */
export function isOpen(hours: InboxSettings['businessHours'], timeZone: string, now = new Date()): boolean {
    if (!hours.enabled) return true;
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
            .formatToParts(now)
            .map((p) => [p.type, p.value]),
    );
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    const time = `${parts.hour}:${parts.minute}`;
    return hours.days.some((d) => d.day === day && time >= d.open && time < d.close);
}
