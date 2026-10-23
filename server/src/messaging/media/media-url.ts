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
