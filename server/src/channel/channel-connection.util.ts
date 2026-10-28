import { ChannelPlatform, ChannelStatus } from '@prisma/client';

/**
 * Connection management for channels, as pure functions.
 *
 * A Channel row is one CONNECTED ACCOUNT. Everything about "may this org
 * connect this account, or is it a reconnect of one it already has" lives here
 * rather than inside the three OAuth services, because each of them used to
 * answer it differently and two of them answered it wrongly (Instagram refused
 * a second account outright; WhatsApp refused to reconnect its own disconnected
 * one). Pure and colocated-spec'd, per the `*.util.ts` convention in this
 * folder — the OAuth services cannot be unit-tested without mocking Meta.
 */

// ─── CONNECTION STATE ────────────────────────────────────────────────────────

/**
 * What the merchant is told about a connection.
 *
 * Deliberately NOT `ChannelStatus`. That enum is overloaded: `SYNCING` is a
 * Shopify sync phase, and the sync path writes `ERROR`/`CONNECTED` to it for
 * reasons that have nothing to do with whether the account is linked. This is
 * the derived, presentational answer.
 */
export type ConnectionState = 'CONNECTED' | 'ERROR' | 'EXPIRED' | 'DISCONNECTED';

/** A row occupies its org's slot for the platform unless it is disconnected. */
export function isActive(status: ChannelStatus): boolean {
    return status !== ChannelStatus.DISCONNECTED;
}

/**
 * How many accounts of a platform one organization may hold at once.
 * `null` = unbounded.
 *
 * Instagram and Facebook Pages are unbounded: a merchant runs several handles
 * and Pages and must be able to connect all of them. WhatsApp is capped at one because Meta issues
 * one WhatsApp Business Account per business and the messaging services resolve
 * "the org's WhatsApp channel" by lookup, not by choice.
 */
export const CONNECTION_POLICY: Record<
    ChannelPlatform,
    { maxActive: number | null; label: string }
> = {
    [ChannelPlatform.SHOPIFY]: { maxActive: 1, label: 'Shopify' },
    [ChannelPlatform.WOOCOMMERCE]: { maxActive: 1, label: 'WooCommerce' },
    [ChannelPlatform.INSTAGRAM]: { maxActive: null, label: 'Instagram' },
    [ChannelPlatform.FACEBOOK]: { maxActive: null, label: 'Facebook Page' },
    [ChannelPlatform.WHATSAPP]: { maxActive: 1, label: 'WhatsApp Business' },
    [ChannelPlatform.TIKTOK]: { maxActive: 1, label: 'TikTok' },
    [ChannelPlatform.MANUAL]: { maxActive: 1, label: 'Manual' },
};

/**
 * The subset of a Channel row the decision functions need. Keeping it narrow
 * lets callers pass a `select`ed row and lets the spec build fixtures by hand.
 */
export interface ChannelRowLite {
    id: string;
    platform: ChannelPlatform;
    status: ChannelStatus;
    externalStoreId: string | null;
    metadata?: unknown;
    /** The member who personally connected this, or null for an org channel. */
    ownerUserId?: string | null;
}

export type ConnectBlockReason =
    | 'limit_reached'
    | 'already_connected'
    | 'reconnect_target_invalid';

export type ConnectDecision =
    | { kind: 'create' }
    | { kind: 'reconnect'; channelId: string; sameAccount: boolean }
    | { kind: 'blocked'; reason: ConnectBlockReason; channelId?: string; message: string };

/** The account id a disconnected row used to hold, stashed by `disconnect`. */
function previousAccountId(row: ChannelRowLite): string | null {
    const meta = row.metadata;
    if (!meta || typeof meta !== 'object') return null;
    const value = (meta as Record<string, unknown>).externalAccountId;
    return typeof value === 'string' && value ? value : null;
}

/** The account id a row currently claims, live or historical. */
function accountIdOf(row: ChannelRowLite): string | null {
    return row.externalStoreId ?? previousAccountId(row);
}

/**
 * STAGE 1 — before the OAuth redirect, when the account is not yet known.
 *
 * Can only enforce the per-org limit and validate an explicit reconnect target.
 * Duplicate detection has to wait for stage 2: which account the merchant will
 * pick is decided inside Meta's UI, not here.
 */
export function assertCanConnect(
    rows: ChannelRowLite[],
    platform: ChannelPlatform,
    reconnectChannelId?: string,
): ConnectDecision {
    const policy = CONNECTION_POLICY[platform];
    const ofPlatform = rows.filter((r) => r.platform === platform);

    if (reconnectChannelId) {
        const target = ofPlatform.find((r) => r.id === reconnectChannelId);
        if (!target) {
            return {
                kind: 'blocked',
                reason: 'reconnect_target_invalid',
                message: 'That channel no longer exists. Refresh the page and try again.',
            };
        }
        return { kind: 'reconnect', channelId: target.id, sameAccount: true };
    }

    const active = ofPlatform.filter((r) => isActive(r.status));
    if (policy.maxActive !== null && active.length >= policy.maxActive) {
        return {
            kind: 'blocked',
            reason: 'limit_reached',
            channelId: active[0].id,
            message: `A ${policy.label} account is already connected. Disconnect it before connecting another.`,
        };
    }

    return { kind: 'create' };
}

/**
 * STAGE 2 — after OAuth, with the provider's account id in hand.
 *
 * Runs again on the way back rather than trusting stage 1, because the merchant
 * spent the intervening seconds inside Meta and may have picked an account
 * another tab (or another user in the same org) connected meanwhile.
 *
 * Order matters:
 *   1. This exact account is already live here → re-auth, not a duplicate. The
 *      merchant is refreshing an expiring grant; creating a second row would
 *      trip the global (platform, external_store_id) unique anyway.
 *   2. This exact account is in a DISCONNECTED row → revive it, so the history
 *      hanging off that row (orders, message logs) reattaches to its own
 *      account instead of being orphaned beside a new row.
 *   3. An explicit reconnect target on a single-account platform → replace the
 *      account in that row (merchant swapping which WABA the org uses).
 *   4. Otherwise the limit decides.
 *
 * Note (3) deliberately does NOT apply to Instagram: reconnecting an errored
 * Instagram row with a *different* handle should add that handle and leave the
 * errored row alone to be fixed or disconnected on its own.
 */
export function resolveConnectTarget(
    rows: ChannelRowLite[],
    platform: ChannelPlatform,
    externalId: string,
    reconnectChannelId?: string,
    /**
     * Who is connecting. When given, a live row belonging to a DIFFERENT member
     * is refused instead of being re-authorized — otherwise one influencer
     * could connect an account another influencer already holds and silently
     * overwrite their tokens, taking the account over.
     */
    actingUserId?: string,
): ConnectDecision {
    const policy = CONNECTION_POLICY[platform];
    const ofPlatform = rows.filter((r) => r.platform === platform);

    const liveSame = ofPlatform.find(
        (r) => isActive(r.status) && r.externalStoreId === externalId,
    );
    if (liveSame) {
        const belongsToSomeoneElse =
            !!liveSame.ownerUserId && !!actingUserId && liveSame.ownerUserId !== actingUserId;
        if (belongsToSomeoneElse) {
            return {
                kind: 'blocked',
                reason: 'already_connected',
                channelId: liveSame.id,
                message: 'This Instagram account is already connected to this organization.',
            };
        }
        return { kind: 'reconnect', channelId: liveSame.id, sameAccount: true };
    }

    const historicalSame = ofPlatform.find(
        (r) => !isActive(r.status) && previousAccountId(r) === externalId,
    );
    if (historicalSame) {
        // A disconnected row someone else owned is history, not a claim: the
        // account is free, so the new connector gets their own row rather than
        // inheriting the old owner's.
        const wasSomeoneElses =
            !!historicalSame.ownerUserId &&
            !!actingUserId &&
            historicalSame.ownerUserId !== actingUserId;
        if (!wasSomeoneElses) {
            return { kind: 'reconnect', channelId: historicalSame.id, sameAccount: false };
        }
    }

    if (reconnectChannelId && policy.maxActive === 1) {
        const target = ofPlatform.find((r) => r.id === reconnectChannelId);
        if (target) {
            return { kind: 'reconnect', channelId: target.id, sameAccount: false };
        }
    }

    const active = ofPlatform.filter((r) => isActive(r.status));
    if (policy.maxActive !== null && active.length >= policy.maxActive) {
        return {
            kind: 'blocked',
            reason: 'limit_reached',
            channelId: active[0].id,
            message: `A ${policy.label} account is already connected. Disconnect it before connecting another.`,
        };
    }

    return { kind: 'create' };
}

// ─── WEBHOOK ROUTING ─────────────────────────────────────────────────────────

/**
 * The row an inbound Meta webhook belongs to, among the rows claiming its
 * account id.
 *
 * The webhook is signed with the app's secret, which names no tenant, so the
 * account id is the only tenant selector. The (platform, external_store_id)
 * unique index leaves at most one row; a database that could not build it may
 * hold more, and then the choice must not fall to row order: a CONNECTED row
 * before an errored one, then the longest connected. A disconnected row is
 * never chosen.
 */
export function pickRoutingChannel<T extends { id: string; status: ChannelStatus; connectedAt: Date | null }>(
    rows: T[],
): T | null {
    const since = (r: T) => r.connectedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const [first] = rows
        .filter((r) => isActive(r.status))
        .sort(
            (a, b) =>
                Number(b.status === ChannelStatus.CONNECTED) - Number(a.status === ChannelStatus.CONNECTED) ||
                since(a) - since(b) ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
    return first ?? null;
}

/**
 * What the merchant sees as the connection's health.
 *
 * Ordering is the whole content: a disconnected row is not "expired", and an
 * errored row reports its error rather than an expiry the error probably caused.
 * `SYNCING` is a Shopify data-sync phase and says nothing about the link, so it
 * reads as connected.
 */
export function deriveConnectionState(
    row: { status: ChannelStatus; tokenExpiresAt?: Date | string | null },
    now: Date = new Date(),
): ConnectionState {
    if (row.status === ChannelStatus.DISCONNECTED) return 'DISCONNECTED';
    if (row.status === ChannelStatus.ERROR) return 'ERROR';

    if (row.tokenExpiresAt) {
        const expiry = new Date(row.tokenExpiresAt);
        if (!Number.isNaN(expiry.getTime()) && expiry.getTime() <= now.getTime()) {
            return 'EXPIRED';
        }
    }
    return 'CONNECTED';
}

// ─── ACCOUNT SUMMARY ─────────────────────────────────────────────────────────

/**
 * The non-secret identity of a connected account, safe to return over the API.
 *
 * Built by whitelisting known display fields — never by spreading credentials
 * and deleting the secrets, which is one forgotten key away from leaking a
 * token.
 */
export interface ChannelAccountSummary {
    /** Provider account id: IG business account id, WABA id, Shopify shop id. */
    externalId: string | null;
    /** The short label a merchant recognises: @handle, phone number, domain. */
    handle: string | null;
    /** Human name of the account, when the provider gives one. */
    displayName: string | null;
    avatarUrl: string | null;
    /** One line of extra context: which Page, which WABA. */
    detail: string | null;
}

function str(source: Record<string, unknown> | null, key: string): string | null {
    if (!source) return null;
    const value = source[key];
    return typeof value === 'string' && value ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Instagram's `account_type` as the merchant would say it. */
function instagramAccountTypeLabel(accountType: string | null): string | null {
    if (accountType === 'BUSINESS') return 'Business account';
    if (accountType === 'MEDIA_CREATOR') return 'Creator account';
    return null;
}

/**
 * Describe a channel's account for display.
 *
 * Falls back to `metadata.lastAccount` when `credentials` is null, which is
 * exactly the disconnected case: the row must still be able to say WHICH
 * account it used to be, or the connected-accounts table shows a nameless
 * "Not connected" row the merchant cannot identify.
 */
export function describeAccount(
    platform: ChannelPlatform,
    credentials: unknown,
    metadata?: unknown,
): ChannelAccountSummary | null {
    const creds = asRecord(credentials);
    const meta = asRecord(metadata);

    if (!creds) {
        const last = asRecord(meta?.lastAccount);
        if (!last) return null;
        return {
            externalId: str(last, 'externalId'),
            handle: str(last, 'handle'),
            displayName: str(last, 'displayName'),
            avatarUrl: str(last, 'avatarUrl'),
            detail: str(last, 'detail'),
        };
    }

    switch (platform) {
        case ChannelPlatform.INSTAGRAM: {
            const username = str(creds, 'instagramUsername');
            // Only rows connected through the old Facebook Login flow have a Page.
            const pageName = str(creds, 'pageName');
            return {
                externalId: str(creds, 'instagramUserId'),
                handle: username ? `@${username}` : null,
                displayName: str(creds, 'name') ?? pageName,
                avatarUrl: str(creds, 'profilePictureUrl'),
                detail: pageName
                    ? `Facebook Page: ${pageName}`
                    : instagramAccountTypeLabel(str(creds, 'accountType')),
            };
        }
        case ChannelPlatform.WHATSAPP: {
            // Quality has its own row in the messaging status; this line only
            // says which account and whether the Business app shares the number.
            const waba = str(creds, 'wabaName');
            const detail = [waba, creds.isOnBizApp === true ? 'also on the WhatsApp Business app' : null]
                .filter(Boolean)
                .join(' · ');
            return {
                externalId: str(creds, 'wabaId'),
                handle: str(creds, 'displayPhoneNumber'),
                displayName: str(creds, 'verifiedName'),
                avatarUrl: null,
                detail: detail || null,
            };
        }
        case ChannelPlatform.FACEBOOK: {
            const pageName = str(creds, 'pageName');
            return {
                externalId: str(creds, 'pageId'),
                handle: pageName,
                displayName: pageName,
                avatarUrl: str(creds, 'pictureUrl'),
                detail: 'Facebook Page · Messenger',
            };
        }
        case ChannelPlatform.SHOPIFY: {
            const domain = str(creds, 'shopDomain');
            return {
                externalId: null,
                handle: domain,
                displayName: null,
                avatarUrl: null,
                detail: null,
            };
        }
        default:
            return null;
    }
}

/** Messaging health for the channels page: whitelisted, never a token. */
export interface MessagingStatusSummary {
    /** WhatsApp number also used on the WhatsApp Business app (coexistence). */
    isOnBizApp: boolean;
    quality: string | null;
    messagingLimit: string | null;
    throughput: string | null;
    nameStatus: string | null;
    coexistence: { state: string; sendsPaused: boolean } | null;
    historySync: {
        status: string;
        progress: number | null;
        messagesReceived: number | null;
        error: string | null;
    } | null;
    setup: { webhooks: string; registration: string } | null;
    /** Pages and Instagram accounts: did the webhook subscription succeed. */
    webhooksOk: boolean | null;
    /** WhatsApp: whether Meta lets the number send (AVAILABLE, LIMITED, BLOCKED), and why not. */
    sending: { state: string; problems: Array<{ description: string; solution: string | null }> } | null;
}

/** Meta's health_status, reduced to what stops or limits sending. Calling-only (SIP) errors are left out. */
export function describeSending(number: Record<string, unknown> | null): MessagingStatusSummary['sending'] {
    const health = asRecord(number?.health_status);
    const state = str(health, 'can_send_message');
    if (!state) return null;
    const entities = Array.isArray(health?.entities) ? (health.entities as Array<Record<string, unknown>>) : [];
    const problems = entities
        .filter((e) => e.can_send_message && e.can_send_message !== 'AVAILABLE')
        .flatMap((e) => (Array.isArray(e.errors) ? (e.errors as Array<Record<string, unknown>>) : []))
        .map((e) => ({ description: String(e.error_description ?? 'Meta reported a problem.'), solution: typeof e.possible_solution === 'string' ? e.possible_solution : null }));
    return { state, problems };
}

function num(source: Record<string, unknown> | null, key: string): number | null {
    const value = source?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The messaging-specific state a merchant needs to see on a channel, read
 * from the places the connect flow and webhooks write it. Null for
 * non-messaging platforms.
 */
export function describeMessagingStatus(
    platform: ChannelPlatform,
    credentials: unknown,
    metadata: unknown,
): MessagingStatusSummary | null {
    if (
        platform !== ChannelPlatform.WHATSAPP &&
        platform !== ChannelPlatform.FACEBOOK &&
        platform !== ChannelPlatform.INSTAGRAM
    ) {
        return null;
    }
    const creds = asRecord(credentials);
    const meta = asRecord(metadata);
    const health = asRecord(meta?.health);
    const number = asRecord(health?.number);
    const quality = asRecord(health?.quality);
    const coexistence = asRecord(meta?.coexistence);
    const history = asRecord(meta?.historySync);
    const setup = asRecord(meta?.setup);
    const subscription = asRecord(meta?.webhookSubscription);

    return {
        isOnBizApp: creds?.isOnBizApp === true,
        quality: str(number, 'quality_rating') ?? str(creds, 'qualityRating'),
        messagingLimit:
            str(quality, 'current_limit') ?? str(number, 'whatsapp_business_manager_messaging_limit'),
        throughput: str(asRecord(number?.throughput), 'level'),
        nameStatus: str(number, 'name_status'),
        coexistence: coexistence
            ? { state: str(coexistence, 'state') ?? 'connected', sendsPaused: coexistence.sendsPaused === true }
            : null,
        historySync: history
            ? {
                status: str(history, 'status') ?? 'pending',
                progress: num(history, 'progress'),
                messagesReceived: num(history, 'messagesReceived'),
                error: str(history, 'error'),
            }
            : null,
        setup: setup
            ? { webhooks: str(setup, 'webhooks') ?? 'ok', registration: str(setup, 'registration') ?? 'ok' }
            : null,
        webhooksOk: subscription ? subscription.ok === true : null,
        sending: platform === ChannelPlatform.WHATSAPP ? describeSending(number) : null,
    };
}

/**
 * When a channel's grant runs out, as an ISO string, or null when it does not.
 *
 * Shopify's non-expiring offline tokens have no expiry field at all, and
 * WhatsApp Embedded Signup issues a system-user token that never expires — both
 * correctly yield null rather than a fabricated date, or the UI would mark a
 * healthy channel EXPIRED.
 */
export function readTokenExpiry(credentials: unknown): string | null {
    const creds = asRecord(credentials);
    if (!creds) return null;
    return str(creds, 'tokenExpiresAt') ?? str(creds, 'refreshTokenExpiresAt');
}

// ─── CALLBACK ERROR CLASSIFICATION ───────────────────────────────────────────

export type MetaCallbackReason =
    | 'cancelled'
    | 'invalid_state'
    | 'no_pages'
    | 'no_instagram_account'
    | 'not_professional_account'
    | 'scopes_declined'
    | 'already_connected'
    | 'limit_reached'
    | 'account_taken'
    | 'connect_failed';

/**
 * Turn a failed Meta callback into a slug the frontend maps to copy.
 *
 * The merchant's browser is parked on the callback URL, so every outcome has to
 * become a redirect carrying a reason — the same contract `shopifyCallback`
 * already uses. Cancelling is read off the query (Meta sends
 * `error=access_denied&error_reason=user_denied` and NO code), everything else
 * off the thrown message.
 */
export function classifyMetaCallbackError(
    query: Record<string, string | undefined>,
    error?: unknown,
): MetaCallbackReason {
    if (query.error === 'access_denied' || query.error_reason === 'user_denied') {
        return 'cancelled';
    }

    const message = error instanceof Error ? error.message : '';
    if (/cancelled/i.test(message)) return 'cancelled';
    if (/state parameter/i.test(message)) return 'invalid_state';
    if (/another organization/i.test(message)) return 'account_taken';
    // Order matters: the limit message ends "...is already connected. Disconnect
    // it before connecting another.", so it has to be recognised BEFORE the
    // bare already-connected test or it is swallowed by it.
    if (/Disconnect it before/i.test(message)) return 'limit_reached';
    if (/already connected/i.test(message)) return 'already_connected';
    if (/No Instagram Business/i.test(message)) return 'no_instagram_account';
    if (/No Facebook Pages/i.test(message)) return 'no_pages';
    // After no_instagram_account: that older message also says "Business or Creator".
    if (/Only Instagram Business or Creator/i.test(message)) return 'not_professional_account';
    if (/permissions were declined/i.test(message)) return 'scopes_declined';
    return 'connect_failed';
}
