import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import {
    assertCanConnect,
    resolveConnectTarget,
    deriveConnectionState,
    describeAccount,
    readTokenExpiry,
    classifyMetaCallbackError,
    isActive,
    CONNECTION_POLICY,
    type ChannelRowLite,
} from './channel-connection.util';

/**
 * Pins the connection rules that used to be spread across three OAuth services
 * and disagreed with each other:
 *   - Instagram refused a second account outright (the bug this work fixes).
 *   - WhatsApp refused to reconnect its OWN disconnected account.
 *   - Neither could tell "this account again" from "another account".
 *
 * The two decision functions are the whole product spec for "who may connect
 * what", so they are tested as such rather than through Meta-mocking.
 */

const row = (over: Partial<ChannelRowLite> = {}): ChannelRowLite => ({
    id: 'ch_1',
    platform: ChannelPlatform.INSTAGRAM,
    status: ChannelStatus.CONNECTED,
    externalStoreId: 'ig_1',
    metadata: null,
    ...over,
});

describe('CONNECTION_POLICY', () => {
    it('caps every platform at one account except Instagram', () => {
        expect(CONNECTION_POLICY[ChannelPlatform.INSTAGRAM].maxActive).toBeNull();
        expect(CONNECTION_POLICY[ChannelPlatform.WHATSAPP].maxActive).toBe(1);
        expect(CONNECTION_POLICY[ChannelPlatform.SHOPIFY].maxActive).toBe(1);
        expect(CONNECTION_POLICY[ChannelPlatform.MANUAL].maxActive).toBe(1);
    });
});

describe('isActive', () => {
    it('counts every non-disconnected status as occupying the slot', () => {
        expect(isActive(ChannelStatus.CONNECTED)).toBe(true);
        // ERROR and SYNCING still hold the account — a merchant fixing a broken
        // connection must reconnect it, not connect a second one beside it.
        expect(isActive(ChannelStatus.ERROR)).toBe(true);
        expect(isActive(ChannelStatus.SYNCING)).toBe(true);
        expect(isActive(ChannelStatus.DISCONNECTED)).toBe(false);
    });
});

describe('assertCanConnect', () => {
    it('lets an org start a WhatsApp connect when it has none', () => {
        expect(assertCanConnect([], ChannelPlatform.WHATSAPP)).toEqual({ kind: 'create' });
    });

    it('blocks a second WhatsApp account while one is connected', () => {
        const rows = [row({ platform: ChannelPlatform.WHATSAPP, externalStoreId: 'waba_1' })];
        const decision = assertCanConnect(rows, ChannelPlatform.WHATSAPP);
        expect(decision).toMatchObject({ kind: 'blocked', reason: 'limit_reached', channelId: 'ch_1' });
    });

    it('blocks a second WhatsApp account even while the first is in ERROR', () => {
        const rows = [
            row({ platform: ChannelPlatform.WHATSAPP, status: ChannelStatus.ERROR }),
        ];
        expect(assertCanConnect(rows, ChannelPlatform.WHATSAPP)).toMatchObject({
            reason: 'limit_reached',
        });
    });

    it('allows WhatsApp again once the existing account is disconnected', () => {
        const rows = [
            row({
                platform: ChannelPlatform.WHATSAPP,
                status: ChannelStatus.DISCONNECTED,
                externalStoreId: null,
            }),
        ];
        expect(assertCanConnect(rows, ChannelPlatform.WHATSAPP)).toEqual({ kind: 'create' });
    });

    it('never blocks Instagram, however many are already connected', () => {
        const rows = [
            row({ id: 'a', externalStoreId: 'ig_a' }),
            row({ id: 'b', externalStoreId: 'ig_b' }),
            row({ id: 'c', externalStoreId: 'ig_c' }),
        ];
        expect(assertCanConnect(rows, ChannelPlatform.INSTAGRAM)).toEqual({ kind: 'create' });
    });

    it('ignores channels of other platforms when counting the limit', () => {
        const rows = [row({ platform: ChannelPlatform.SHOPIFY, externalStoreId: 'shop_1' })];
        expect(assertCanConnect(rows, ChannelPlatform.WHATSAPP)).toEqual({ kind: 'create' });
    });

    it('accepts an explicit reconnect target of the same platform', () => {
        const rows = [row({ id: 'ch_x', status: ChannelStatus.ERROR })];
        expect(assertCanConnect(rows, ChannelPlatform.INSTAGRAM, 'ch_x')).toEqual({
            kind: 'reconnect',
            channelId: 'ch_x',
            sameAccount: true,
        });
    });

    it('rejects a reconnect target that is not a channel of this platform', () => {
        const rows = [row({ id: 'ch_x', platform: ChannelPlatform.SHOPIFY })];
        expect(assertCanConnect(rows, ChannelPlatform.INSTAGRAM, 'ch_x')).toMatchObject({
            kind: 'blocked',
            reason: 'reconnect_target_invalid',
        });
    });
});

describe('resolveConnectTarget', () => {
    it('treats re-authing a live account as a refresh of that same row', () => {
        const rows = [row({ id: 'ch_live', externalStoreId: 'ig_1' })];
        expect(resolveConnectTarget(rows, ChannelPlatform.INSTAGRAM, 'ig_1')).toEqual({
            kind: 'reconnect',
            channelId: 'ch_live',
            sameAccount: true,
        });
    });

    it('revives the disconnected row that used to hold this account', () => {
        // disconnect() nulls externalStoreId to release the global claim and
        // stashes the id here, which is the only way back to the right row.
        const rows = [
            row({
                id: 'ch_old',
                status: ChannelStatus.DISCONNECTED,
                externalStoreId: null,
                metadata: { externalAccountId: 'ig_1' },
            }),
        ];
        expect(resolveConnectTarget(rows, ChannelPlatform.INSTAGRAM, 'ig_1')).toEqual({
            kind: 'reconnect',
            channelId: 'ch_old',
            sameAccount: false,
        });
    });

    it('creates a new row for a different Instagram account', () => {
        const rows = [row({ id: 'ch_a', externalStoreId: 'ig_a' })];
        expect(resolveConnectTarget(rows, ChannelPlatform.INSTAGRAM, 'ig_b')).toEqual({
            kind: 'create',
        });
    });

    it('blocks a different WhatsApp account while one is live', () => {
        const rows = [
            row({ platform: ChannelPlatform.WHATSAPP, externalStoreId: 'waba_1' }),
        ];
        expect(
            resolveConnectTarget(rows, ChannelPlatform.WHATSAPP, 'waba_2'),
        ).toMatchObject({ kind: 'blocked', reason: 'limit_reached' });
    });

    it('lets an explicit reconnect swap the account on a single-account platform', () => {
        const rows = [
            row({
                id: 'ch_wa',
                platform: ChannelPlatform.WHATSAPP,
                status: ChannelStatus.ERROR,
                externalStoreId: 'waba_1',
            }),
        ];
        expect(
            resolveConnectTarget(rows, ChannelPlatform.WHATSAPP, 'waba_2', 'ch_wa'),
        ).toEqual({ kind: 'reconnect', channelId: 'ch_wa', sameAccount: false });
    });

    it("refuses an account another member already holds, rather than taking it over", () => {
    // The influencer case: without the owner check this returned
    // reconnect{sameAccount:true} on someone else's row, and connecting would
    // have overwritten their tokens — silently transferring the account.
    const rows = [
      row({ id: 'ch_hers', externalStoreId: 'ig_shared', ownerUserId: 'user_a' }),
    ];
    expect(
      resolveConnectTarget(rows, ChannelPlatform.INSTAGRAM, 'ig_shared', undefined, 'user_b'),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'already_connected',
      message: 'This Instagram account is already connected to this organization.',
    });
  });

  it('still lets the OWNING member re-authorize their own account', () => {
    const rows = [
      row({ id: 'ch_mine', externalStoreId: 'ig_shared', ownerUserId: 'user_a' }),
    ];
    expect(
      resolveConnectTarget(rows, ChannelPlatform.INSTAGRAM, 'ig_shared', undefined, 'user_a'),
    ).toEqual({ kind: 'reconnect', channelId: 'ch_mine', sameAccount: true });
  });

  it('treats an unowned org channel as re-authorizable by anyone who may connect', () => {
    // Shopify and the admin-linked WhatsApp number have no owner; two admins
    // must both be able to re-authorize them.
    const rows = [row({ id: 'ch_org', externalStoreId: 'ig_org', ownerUserId: null })];
    expect(
      resolveConnectTarget(rows, ChannelPlatform.INSTAGRAM, 'ig_org', undefined, 'user_b'),
    ).toEqual({ kind: 'reconnect', channelId: 'ch_org', sameAccount: true });
  });

  it('gives a new connector their own row rather than reviving a former owner\'s', () => {
    const rows = [
      row({
        id: 'ch_theirs',
        status: ChannelStatus.DISCONNECTED,
        externalStoreId: null,
        ownerUserId: 'user_a',
        metadata: { externalAccountId: 'ig_free' },
      }),
    ];
    expect(
      resolveConnectTarget(rows, ChannelPlatform.INSTAGRAM, 'ig_free', undefined, 'user_b'),
    ).toEqual({ kind: 'create' });
  });

  it('adds a new row when an Instagram reconnect returns a different handle', () => {
        // Instagram is unbounded, so a "reconnect" that comes back with another
        // account is a second account — the errored row stays for its own fix.
        const rows = [row({ id: 'ch_a', status: ChannelStatus.ERROR, externalStoreId: 'ig_a' })];
        expect(
            resolveConnectTarget(rows, ChannelPlatform.INSTAGRAM, 'ig_b', 'ch_a'),
        ).toEqual({ kind: 'create' });
    });
});

describe('deriveConnectionState', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    const past = '2026-09-01T00:00:00.000Z';
    const future = '2026-12-01T00:00:00.000Z';

    it('reports a disconnected row as disconnected even with a stale expiry', () => {
        expect(
            deriveConnectionState({ status: ChannelStatus.DISCONNECTED, tokenExpiresAt: past }, now),
        ).toBe('DISCONNECTED');
    });

    it('prefers the recorded error over an expiry the error likely caused', () => {
        expect(
            deriveConnectionState({ status: ChannelStatus.ERROR, tokenExpiresAt: past }, now),
        ).toBe('ERROR');
    });

    it('marks a connected row with a lapsed token as expired', () => {
        expect(
            deriveConnectionState({ status: ChannelStatus.CONNECTED, tokenExpiresAt: past }, now),
        ).toBe('EXPIRED');
    });

    it('leaves a connected row with a live token alone', () => {
        expect(
            deriveConnectionState({ status: ChannelStatus.CONNECTED, tokenExpiresAt: future }, now),
        ).toBe('CONNECTED');
    });

    it('treats a missing expiry as healthy, not expired', () => {
        // Shopify offline tokens and WhatsApp system-user tokens never expire.
        expect(deriveConnectionState({ status: ChannelStatus.CONNECTED, tokenExpiresAt: null }, now)).toBe(
            'CONNECTED',
        );
        expect(deriveConnectionState({ status: ChannelStatus.CONNECTED }, now)).toBe('CONNECTED');
    });

    it('reads SYNCING as connected — it is a data phase, not a link state', () => {
        expect(deriveConnectionState({ status: ChannelStatus.SYNCING }, now)).toBe('CONNECTED');
    });

    it('ignores an unparseable expiry rather than reporting a false expiry', () => {
        expect(
            deriveConnectionState({ status: ChannelStatus.CONNECTED, tokenExpiresAt: 'not-a-date' }, now),
        ).toBe('CONNECTED');
    });
});

describe('describeAccount', () => {
    const igCreds = {
        userAccessToken: 'ENCRYPTED_USER_TOKEN',
        pageAccessToken: 'ENCRYPTED_PAGE_TOKEN',
        pageId: '999',
        pageName: 'Acme Store',
        instagramUserId: 'ig_1',
        instagramUsername: 'acme',
        profilePictureUrl: 'https://cdn/pic.jpg',
        tokenExpiresAt: '2026-12-01T00:00:00.000Z',
        scopes: 'instagram_basic',
    };

    it('summarises an Instagram account by handle and Page', () => {
        expect(describeAccount(ChannelPlatform.INSTAGRAM, igCreds)).toEqual({
            externalId: 'ig_1',
            handle: '@acme',
            displayName: 'Acme Store',
            avatarUrl: 'https://cdn/pic.jpg',
            detail: 'Facebook Page: Acme Store',
        });
    });

    it('never carries a token into the summary', () => {
        const summary = describeAccount(ChannelPlatform.INSTAGRAM, igCreds);
        const serialised = JSON.stringify(summary);
        expect(serialised).not.toContain('ENCRYPTED_USER_TOKEN');
        expect(serialised).not.toContain('ENCRYPTED_PAGE_TOKEN');
        expect(Object.keys(summary!)).toEqual([
            'externalId',
            'handle',
            'displayName',
            'avatarUrl',
            'detail',
        ]);
    });

    it('summarises WhatsApp by phone number, verified name and WABA', () => {
        expect(
            describeAccount(ChannelPlatform.WHATSAPP, {
                wabaId: 'waba_1',
                wabaName: 'Acme Business',
                displayPhoneNumber: '+91 98765 43210',
                verifiedName: 'Acme',
                qualityRating: 'GREEN',
                accessToken: 'ENCRYPTED',
            }),
        ).toEqual({
            externalId: 'waba_1',
            handle: '+91 98765 43210',
            displayName: 'Acme',
            avatarUrl: null,
            detail: 'Acme Business · quality green',
        });
    });

    it('summarises Shopify by shop domain', () => {
        expect(
            describeAccount(ChannelPlatform.SHOPIFY, {
                accessToken: 'ENCRYPTED',
                shopDomain: 'acme.myshopify.com',
            }),
        ).toMatchObject({ handle: 'acme.myshopify.com' });
    });

    it('falls back to the stashed summary once credentials are cleared', () => {
        // A disconnected row must still say WHICH account it was, or the table
        // shows an unidentifiable "Not connected" line.
        expect(
            describeAccount(ChannelPlatform.INSTAGRAM, null, {
                externalAccountId: 'ig_1',
                lastAccount: {
                    externalId: 'ig_1',
                    handle: '@acme',
                    displayName: 'Acme Store',
                    avatarUrl: null,
                    detail: 'Facebook Page: Acme Store',
                },
            }),
        ).toMatchObject({ handle: '@acme', externalId: 'ig_1' });
    });

    it('returns null when there is nothing to describe', () => {
        expect(describeAccount(ChannelPlatform.INSTAGRAM, null, null)).toBeNull();
        expect(describeAccount(ChannelPlatform.MANUAL, { anything: true })).toBeNull();
    });
});

describe('readTokenExpiry', () => {
    it('reads the Meta token expiry', () => {
        expect(readTokenExpiry({ tokenExpiresAt: '2026-12-01T00:00:00.000Z' })).toBe(
            '2026-12-01T00:00:00.000Z',
        );
    });

    it('falls back to the Shopify refresh-token expiry', () => {
        expect(readTokenExpiry({ refreshTokenExpiresAt: '2026-11-01T00:00:00.000Z' })).toBe(
            '2026-11-01T00:00:00.000Z',
        );
    });

    it('returns null for non-expiring grants rather than inventing a date', () => {
        expect(readTokenExpiry({ accessToken: 'x' })).toBeNull();
        expect(readTokenExpiry(null)).toBeNull();
    });
});

describe('classifyMetaCallbackError', () => {
    it('reads a denied authorization straight off the query', () => {
        // Meta sends no `code` at all in this case, so the message is useless.
        expect(
            classifyMetaCallbackError({ error: 'access_denied', error_reason: 'user_denied' }),
        ).toBe('cancelled');
    });

    it('maps a stale or replayed state to invalid_state', () => {
        expect(
            classifyMetaCallbackError({}, new Error('Invalid or expired state parameter')),
        ).toBe('invalid_state');
    });

    it('separates an account held elsewhere from one already connected here', () => {
        expect(
            classifyMetaCallbackError(
                {},
                new Error('This Instagram account is already connected to another organization.'),
            ),
        ).toBe('account_taken');
        expect(
            classifyMetaCallbackError({}, new Error('All of those accounts are already connected')),
        ).toBe('already_connected');
    });

    it('maps the per-org limit message', () => {
        expect(
            classifyMetaCallbackError(
                {},
                new Error('A WhatsApp Business account is already connected. Disconnect it before connecting another.'),
            ),
        ).toBe('limit_reached');
    });

    it('maps the two Meta prerequisite failures', () => {
        expect(
            classifyMetaCallbackError({}, new Error('No Facebook Pages found.')),
        ).toBe('no_pages');
        expect(
            classifyMetaCallbackError({}, new Error('No Instagram Business account found')),
        ).toBe('no_instagram_account');
    });

    it('falls back to a generic failure', () => {
        expect(classifyMetaCallbackError({}, new Error('socket hang up'))).toBe('connect_failed');
        expect(classifyMetaCallbackError({})).toBe('connect_failed');
    });
});
