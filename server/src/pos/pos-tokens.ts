import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Tokens the till holds after a PIN: a staff unlock (12 hours) or a manager's
 * approval (5 minutes, single use). Signed with a key derived from the access
 * token secret, so they need no new configuration and cannot be minted by a
 * client, and bound to the organization and the member signed in on the
 * device, so a token copied to another login is worthless.
 */

export type PosTokenKind = 'staff' | 'approval';
export type PosApprovalReason = 'discount' | 'price_override';

export interface PosTokenClaims {
    kind: PosTokenKind;
    org: string;
    /** The Collabo member signed in on the device. */
    user: string;
    /** The staff member who unlocked, or the manager who approved. */
    staff: string;
    reason?: PosApprovalReason;
    /** The discount the manager approved, when they named one. */
    amount?: number;
    jti: string;
    /** Epoch milliseconds. */
    exp: number;
}

export const STAFF_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1000;

const PREFIX = 'pos1';

export function posTokenKey(accessSecret: string): Buffer {
    return createHmac('sha256', accessSecret).update('collabo:pos-tokens:v1').digest();
}

export function signPosToken(key: Buffer, claims: Omit<PosTokenClaims, 'jti'>): { token: string; claims: PosTokenClaims } {
    const full: PosTokenClaims = { ...claims, jti: randomUUID() };
    const body = Buffer.from(JSON.stringify(full)).toString('base64url');
    const sig = createHmac('sha256', key).update(body).digest('base64url');
    return { token: `${PREFIX}.${body}.${sig}`, claims: full };
}

/** The claims, or null for a token that is forged, expired, or not for this kind, org and member. */
export function readPosToken(
    key: Buffer,
    token: string | null | undefined,
    expect: { kind: PosTokenKind; org: string; user: string },
    now = Date.now(),
): PosTokenClaims | null {
    if (typeof token !== 'string') return null;
    const [prefix, body, sig] = token.split('.');
    if (prefix !== PREFIX || !body || !sig) return null;
    const expected = createHmac('sha256', key).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: PosTokenClaims;
    try {
        claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PosTokenClaims;
    } catch {
        return null;
    }
    if (claims.kind !== expect.kind || claims.org !== expect.org || claims.user !== expect.user) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    return claims;
}
