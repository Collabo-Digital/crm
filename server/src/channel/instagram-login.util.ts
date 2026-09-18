/**
 * Pure helpers for Instagram Login ("Instagram API with Instagram Login").
 *
 * Kept free of Nest and Prisma so the rules that decide when a token is
 * refreshed — the ones that silently disconnect an account if they are wrong —
 * can be tested directly.
 */

/** `credentials.authFlow` on every row connected through Instagram Login. */
export const INSTAGRAM_LOGIN_FLOW = 'instagram_login';

const DAY_MS = 24 * 60 * 60 * 1000;

/** On-demand refresh (before an API call) once the token is this close to expiry. */
export const INSTAGRAM_REFRESH_AHEAD_MS = 7 * DAY_MS;
/** The daily job reaches further ahead, so a missed run or two costs nothing. */
export const INSTAGRAM_SCHEDULED_REFRESH_AHEAD_MS = 10 * DAY_MS;
/** Meta refuses to refresh a long-lived token younger than 24 hours. */
export const INSTAGRAM_MIN_TOKEN_AGE_MS = DAY_MS;
/** Used only if Meta omits `expires_in`; long-lived tokens last 60 days. */
export const INSTAGRAM_LONG_LIVED_FALLBACK_S = 60 * 24 * 60 * 60;

/** `account_type` values Instagram Login may connect. */
export const PROFESSIONAL_ACCOUNT_TYPES: readonly string[] = ['BUSINESS', 'MEDIA_CREATOR'];

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseTime(value: unknown): number | null {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

export function isInstagramLoginCredentials(credentials: unknown): boolean {
    return asRecord(credentials)?.authFlow === INSTAGRAM_LOGIN_FLOW;
}

/** True once the token's recorded expiry has passed — it can no longer be refreshed. */
export function isInstagramTokenExpired(credentials: unknown, now: Date): boolean {
    const expires = parseTime(asRecord(credentials)?.tokenExpiresAt);
    return expires !== null && expires <= now.getTime();
}

/**
 * Should this token be refreshed now?
 *
 * Only while it is still valid (an expired token cannot be refreshed, only
 * replaced by a reconnect), close enough to expiry to be worth it, and at least
 * 24 hours old (Meta rejects younger ones). An unknown expiry is refreshed:
 * guessing it is fine is how an account quietly disconnects.
 */
export function isInstagramTokenRefreshDue(
    credentials: unknown,
    now: Date,
    withinMs: number,
): boolean {
    const creds = asRecord(credentials);
    if (!creds || creds.authFlow !== INSTAGRAM_LOGIN_FLOW) return false;

    const nowMs = now.getTime();
    const expires = parseTime(creds.tokenExpiresAt);
    if (expires !== null) {
        if (expires <= nowMs) return false;
        if (expires - nowMs > withinMs) return false;
    }

    const issued = parseTime(creds.tokenIssuedAt);
    return issued === null || nowMs - issued >= INSTAGRAM_MIN_TOKEN_AGE_MS;
}

/** Granted permissions arrive as an array or a comma-separated string, depending on the endpoint. */
export function normaliseGrantedScopes(permissions: unknown): string[] {
    if (Array.isArray(permissions)) {
        return permissions.filter((p): p is string => typeof p === 'string' && !!p);
    }
    if (typeof permissions === 'string') {
        return permissions.split(',').map((p) => p.trim()).filter(Boolean);
    }
    return [];
}

export interface InstagramTokenGrant {
    access_token?: string;
    user_id?: string | number;
    permissions?: unknown;
}

/**
 * The code exchange has answered both flat and wrapped in `{ data: [...] }`
 * over time; accept either rather than failing a connect over the envelope.
 */
export function readTokenGrant(body: unknown): InstagramTokenGrant | null {
    const record = asRecord(body);
    if (!record) return null;
    if (Array.isArray(record.data)) {
        return (asRecord(record.data[0]) as InstagramTokenGrant | null) ?? null;
    }
    return record as InstagramTokenGrant;
}
