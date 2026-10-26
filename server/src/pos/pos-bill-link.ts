import { createHmac, timingSafeEqual } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * The public link to a bill, `<app>/b/<token>`, that the WhatsApp bill opens.
 * Stateless: the order's id and an HMAC of it, so a link cannot be guessed or
 * turned into another bill's, and it names no organization, customer or
 * order number. Customers open bills months later, so the key comes from the
 * encryption key — which stored channel credentials already tie down — and
 * not from the JWT secret, whose rotation would break every link sent.
 */

const SIG_BYTES = 16;
/** Order ids are cuids. */
const ORDER_ID = /^[a-z0-9]{8,40}$/i;

export function billLinkKey(secret: string): Buffer {
    return createHmac('sha256', secret).update('collabo:pos-bill-links:v1').digest();
}

const signature = (key: Buffer, orderId: string) =>
    createHmac('sha256', key).update(`bill:${orderId}`).digest().subarray(0, SIG_BYTES).toString('base64url');

export function billToken(key: Buffer, orderId: string): string {
    return `${orderId}.${signature(key, orderId)}`;
}

/** The order a token was made for, or null for one that is forged, cut short or changed. */
export function readBillToken(key: Buffer, token: string | null | undefined): string | null {
    if (typeof token !== 'string' || token.length > 100) return null;
    const [orderId, sig, extra] = token.split('.');
    if (extra !== undefined || !sig || !ORDER_ID.test(orderId)) return null;
    // The encodings, not the decoded bytes: base64url decoding skips characters it does not know.
    const given = Buffer.from(sig);
    const expected = Buffer.from(signature(key, orderId));
    return given.length === expected.length && timingSafeEqual(given, expected) ? orderId : null;
}

/** "+91 98••• ••210": enough for the buyer to know the bill is theirs, not enough to read off a shared link. */
export function maskPhone(phone: string | null | undefined): string | null {
    if (!phone) return null;
    const parsed = parsePhoneNumberFromString(phone, 'IN');
    const national = parsed ? String(parsed.nationalNumber) : phone.replace(/\D/g, '');
    if (national.length < 6) return '•'.repeat(national.length);
    const masked = `${national.slice(0, 2)}${'•'.repeat(national.length - 5)}${national.slice(-3)}`;
    const grouped = masked.length === 10 ? `${masked.slice(0, 5)} ${masked.slice(5)}` : masked;
    return parsed ? `+${parsed.countryCallingCode} ${grouped}` : grouped;
}
