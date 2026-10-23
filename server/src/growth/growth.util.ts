import { randomInt } from 'node:crypto';
import { ChannelPlatform } from '@prisma/client';
import { z } from 'zod';

/** No 0/O, 1/I/L: codes are read off posters and typed in by hand. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function makeCode(length = 8): string {
    let code = '';
    for (let i = 0; i < length; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    return code;
}

/**
 * WhatsApp's pre-filled message ends with the link's reference, so the first
 * message tells which link the chat came from. Customers may edit the text;
 * without the reference the chat simply is not attributed.
 */
export function withReference(text: string | null | undefined, code: string): string {
    const body = (text ?? '').trim();
    return `${body}${body ? '\n\n' : ''}Ref: ${code}`;
}

export function referenceIn(text: string | null | undefined): string | null {
    const m = (text ?? '').match(/\bref[:\s]+([2-9A-HJ-NP-Z]{8})\b/i);
    return m ? m[1].toUpperCase() : null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Where a chat link opens, per channel: wa.me with the pre-filled message,
 * m.me for a Facebook Page (with `ref`, which Messenger hands back), or
 * ig.me for an Instagram account. Null when the channel has no address yet.
 */
export function chatTarget(
    channel: { platform: ChannelPlatform; credentials: unknown; externalStoreId: string | null; externalStoreUrl: string | null },
    code: string,
    prefilledText: string | null,
): string | null {
    const c = (channel.credentials ?? {}) as Obj;
    switch (channel.platform) {
        case ChannelPlatform.WHATSAPP: {
            const digits = (str(c.displayPhoneNumber) ?? '').replace(/\D/g, '');
            if (digits.length < 8) return null;
            return `https://wa.me/${digits}?text=${encodeURIComponent(withReference(prefilledText, code))}`;
        }
        case ChannelPlatform.FACEBOOK: {
            const page = str(c.pageId) ?? channel.externalStoreId;
            return page ? `https://m.me/${encodeURIComponent(page)}?ref=${code}` : null;
        }
        case ChannelPlatform.INSTAGRAM: {
            const username = str(c.instagramUsername) ?? str(c.username) ?? (channel.externalStoreUrl?.match(/instagram\.com\/([^/?#]+)/)?.[1] ?? null);
            return username ? `https://ig.me/m/${encodeURIComponent(username)}` : null;
        }
        default:
            return null;
    }
}

// ─── The website button and pop-up ─────────────────────────────────────────

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #25D366.');

export const WidgetSettingsSchema = z.object({
    button: z.object({
        label: z.string().trim().max(40).default('Chat with us'),
        color: color.default('#25D366'),
        position: z.enum(['right', 'left']).default('right'),
        /** A small bubble beside the button after a few seconds; empty for none. */
        greeting: z.string().trim().max(160).default('Hi! How can we help you today?'),
        greetingDelaySeconds: z.coerce.number().int().min(0).max(120).default(5),
        prefilledText: z.string().trim().max(500).default('Hi! I have a question.'),
        /** Hide the button on phones, for sites with their own mobile footer. */
        hideOnMobile: z.boolean().default(false),
    }).prefault({}),
    popup: z.object({
        enabled: z.boolean().default(false),
        title: z.string().trim().min(1).max(80).default('Get 10% off on WhatsApp'),
        text: z.string().trim().max(300).default('Leave your number and we will send your code on WhatsApp.'),
        buttonLabel: z.string().trim().min(1).max(30).default('Send my code'),
        /** Shown next to the checkbox the visitor must tick; recorded with their opt-in. */
        consentText: z.string().trim().min(10).max(300).default('I agree to receive offers and updates from this store on WhatsApp.'),
        successText: z.string().trim().max(200).default('Done! Check WhatsApp in a moment.'),
        delaySeconds: z.coerce.number().int().min(0).max(300).default(8),
        /** Added to everyone who signs up, for automations and segments. */
        tag: z.string().trim().max(60).default('website-signup'),
        defaultCountryCode: z.string().regex(/^\d{1,3}$/).default('91'),
    }).prefault({}),
});

export type WidgetSettings = z.infer<typeof WidgetSettingsSchema>;

export function parseWidgetSettings(raw: unknown): WidgetSettings {
    const parsed = WidgetSettingsSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : WidgetSettingsSchema.parse({});
}

/** A host name from an Origin or Referer header. */
export function hostOf(url: string | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/** "shop.example.com" is allowed by "example.com" and by itself. */
export function hostAllowed(host: string | null, allowed: string[]): boolean {
    if (!host) return false;
    return allowed.some((d) => {
        const domain = d.toLowerCase().replace(/^\*\./, '');
        return host === domain || host.endsWith(`.${domain}`);
    });
}

/** A domain as typed ("https://www.Shop.com/") stored as a host name ("www.shop.com"). */
export function normalizeDomain(input: string): string | null {
    const raw = input.trim().toLowerCase();
    if (!raw) return null;
    const host = hostOf(raw.includes('://') ? raw : `https://${raw}`);
    return host && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : host === 'localhost' ? host : null;
}
