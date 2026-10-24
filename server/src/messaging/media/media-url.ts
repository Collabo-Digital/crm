import { createHmac, timingSafeEqual } from 'crypto';

/** How long a media link in an API response stays valid. */
export const MEDIA_URL_TTL_S = 15 * 60;

function signature(secret: string, messageId: string, expiresAt: number): string {
    return createHmac('sha256', secret).update(`media:${messageId}:${expiresAt}`).digest('base64url');
}

/**
 * A link an <img>, <video> or download can use without an Authorization
 * header: the message id, an expiry and an HMAC over both. Anyone holding the
 * link can fetch the file until it expires, which is the same exposure as the
 * API response it came in.
 */
export function signMediaPath(secret: string, messageId: string, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + MEDIA_URL_TTL_S;
    return `/inbox/media/${encodeURIComponent(messageId)}?exp=${exp}&sig=${signature(secret, messageId, exp)}`;
}

/// Types a browser shows without running anything the sender wrote.
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);

/**
 * The headers a stored chat file is served with. The type comes from the
 * sender (a customer's WhatsApp document can claim text/html or SVG), so
 * only pictures, audio, video, PDF and plain text open in the browser;
 * anything else downloads as opaque bytes. A sandbox stops scripts in what
 * does open; PDF is left out because Chrome will not show a sandboxed PDF.
 */
export function mediaResponseHeaders(mime: string | null | undefined, filename: string | null): Record<string, string> {
    const type = (mime ?? '').split(';')[0].trim().toLowerCase();
    const inline = INLINE_TYPES.has(type) || /^(audio|video)\/[\w.+-]+$/.test(type);
    const name = filename ? `; filename*=UTF-8''${encodeURIComponent(filename)}` : '';
    return {
        'Content-Type': inline ? type : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}${name}`,
        ...(type === 'application/pdf' ? {} : { 'Content-Security-Policy': 'sandbox' }),
    };
}

export function verifyMediaSignature(
    secret: string,
    messageId: string,
    exp: string | undefined,
    sig: string | undefined,
    now = Date.now(),
): boolean {
    const expiresAt = Number(exp);
    if (!sig || !Number.isInteger(expiresAt) || expiresAt * 1000 < now) return false;
    const expected = Buffer.from(signature(secret, messageId, expiresAt));
    const received = Buffer.from(sig);
    return expected.length === received.length && timingSafeEqual(expected, received);
}
