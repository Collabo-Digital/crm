import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The public links a store message's buttons open, under the app's own
 * address: `<app>/t/<token>` for an order (its courier's tracking page, or the
 * order's status when there is none yet) and `<app>/c/<token>` for an
 * abandoned cart (the store's checkout). A template's button keeps one fixed
 * address from the day Meta approves it, while couriers and checkouts live on
 * many hosts, so the button carries only the token and the page sends the
 * customer on.
 *
 * Stateless, like the bill link: the id and an HMAC of it, so a link cannot be
 * guessed or turned into another order's or cart's. Customers tap these long
 * after the message, so the key comes from the encryption key, not the JWT
 * secret.
 */

export type StoreLinkKind = 'order' | 'cart';

const PATHS: Record<StoreLinkKind, string> = { order: 't', cart: 'c' };
const SIG_BYTES = 16;
/** Order and checkout ids are cuids. */
const ID = /^[a-z0-9]{8,40}$/i;

export function storeLinkKey(secret: string): Buffer {
    return createHmac('sha256', secret).update('collabo:store-links:v1').digest();
}

const signature = (key: Buffer, kind: StoreLinkKind, id: string) =>
    createHmac('sha256', key).update(`${kind}:${id}`).digest().subarray(0, SIG_BYTES).toString('base64url');

/** What a button's `{{1}}` is filled with. */
export function storeLinkToken(key: Buffer, kind: StoreLinkKind, id: string): string {
    return `${id}.${signature(key, kind, id)}`;
}

/** The id a token was made for, or null for one that is forged, cut short, changed or of the other kind. */
export function readStoreLinkToken(key: Buffer, kind: StoreLinkKind, token: string | null | undefined): string | null {
    if (typeof token !== 'string' || token.length > 100) return null;
    const [id, sig, extra] = token.split('.');
    if (extra !== undefined || !sig || !ID.test(id)) return null;
    // The encodings, not the decoded bytes: base64url decoding skips characters it does not know.
    const given = Buffer.from(sig);
    const expected = Buffer.from(signature(key, kind, id));
    return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

/** `<app>/t/` or `<app>/c/`: a template's link button is this plus `{{1}}`. */
export function storeLinkPrefix(frontendUrl: string, kind: StoreLinkKind): string {
    return `${frontendUrl.replace(/\/+$/, '')}/${PATHS[kind]}/`;
}
