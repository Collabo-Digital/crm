import {
    INSTAGRAM_LOGIN_FLOW,
    INSTAGRAM_REFRESH_AHEAD_MS,
    isInstagramTokenExpired,
    isInstagramTokenRefreshDue,
    normaliseGrantedScopes,
    readTokenGrant,
} from './instagram-login.util';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-14T12:00:00.000Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

const creds = (overrides: Record<string, unknown> = {}) => ({
    authFlow: INSTAGRAM_LOGIN_FLOW,
    accessToken: 'ENCRYPTED',
    tokenIssuedAt: at(-55 * DAY),
    tokenExpiresAt: at(5 * DAY),
    ...overrides,
});

describe('isInstagramTokenRefreshDue', () => {
    it('refreshes a valid token that is inside the window and old enough', () => {
        expect(isInstagramTokenRefreshDue(creds(), now, INSTAGRAM_REFRESH_AHEAD_MS)).toBe(true);
    });

    it('leaves a token alone while expiry is still far away', () => {
        expect(
            isInstagramTokenRefreshDue(
                creds({ tokenExpiresAt: at(30 * DAY) }),
                now,
                INSTAGRAM_REFRESH_AHEAD_MS,
            ),
        ).toBe(false);
    });

    it('never refreshes a token younger than 24 hours — Meta rejects it', () => {
        expect(
            isInstagramTokenRefreshDue(
                creds({ tokenIssuedAt: at(-2 * 60 * 60 * 1000), tokenExpiresAt: at(DAY) }),
                now,
                INSTAGRAM_REFRESH_AHEAD_MS,
            ),
        ).toBe(false);
    });

    it('does not try to refresh an already expired token', () => {
        const expired = creds({ tokenExpiresAt: at(-DAY) });
        expect(isInstagramTokenRefreshDue(expired, now, INSTAGRAM_REFRESH_AHEAD_MS)).toBe(false);
        expect(isInstagramTokenExpired(expired, now)).toBe(true);
    });

    it('refreshes when the expiry is unknown rather than assuming it is fine', () => {
        expect(
            isInstagramTokenRefreshDue(
                creds({ tokenExpiresAt: undefined, tokenIssuedAt: undefined }),
                now,
                INSTAGRAM_REFRESH_AHEAD_MS,
            ),
        ).toBe(true);
    });

    it('ignores rows from the old Facebook Login flow', () => {
        expect(
            isInstagramTokenRefreshDue(
                { pageId: '999', tokenExpiresAt: at(DAY) },
                now,
                INSTAGRAM_REFRESH_AHEAD_MS,
            ),
        ).toBe(false);
        expect(isInstagramTokenRefreshDue(null, now, INSTAGRAM_REFRESH_AHEAD_MS)).toBe(false);
    });
});

describe('normaliseGrantedScopes', () => {
    it('accepts an array or a comma-separated string', () => {
        expect(normaliseGrantedScopes(['a', 'b'])).toEqual(['a', 'b']);
        expect(normaliseGrantedScopes('a, b,')).toEqual(['a', 'b']);
        expect(normaliseGrantedScopes(undefined)).toEqual([]);
    });
});

describe('readTokenGrant', () => {
    it('reads the flat and the data-wrapped shapes', () => {
        expect(readTokenGrant({ access_token: 't', user_id: '1' })).toMatchObject({
            access_token: 't',
        });
        expect(readTokenGrant({ data: [{ access_token: 't2' }] })).toMatchObject({
            access_token: 't2',
        });
        expect(readTokenGrant(null)).toBeNull();
    });
});
