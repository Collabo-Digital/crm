import {
    Injectable,
    ConflictException,
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
    Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus, SyncStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS, REDIS_TTL } from '../redis/redis.constants';
import { EncryptionService } from './encryption.service';
import { MetaGraphClient } from './meta-graph.client';
import { MetaGraphError, MetaRequest, metaScope } from './meta-graph.types';
import { Priority, RateLimitScope, isRateLimitedError } from '../rate-limit/rate-limit.types';
import {
    assertCanConnect,
    resolveConnectTarget,
    describeAccount,
    type ChannelAccountSummary,
} from './channel-connection.util';
import {
    INSTAGRAM_LOGIN_FLOW,
    INSTAGRAM_LONG_LIVED_FALLBACK_S,
    INSTAGRAM_REFRESH_AHEAD_MS,
    PROFESSIONAL_ACCOUNT_TYPES,
    isInstagramTokenExpired,
    isInstagramTokenRefreshDue,
    normaliseGrantedScopes,
    readTokenGrant,
} from './instagram-login.util';

/** OAuth state, keyed by the nonce we hand Instagram. */
interface InstagramOAuthState {
    userId: string;
    orgId: string;
    reconnectChannelId?: string;
}

/** The one Instagram professional account an Instagram Login grants. */
interface InstagramCandidate {
    /** The professional account id (`/me` → `user_id`). Webhooks carry it as `entry.id`. */
    igUserId: string;
    /** The app-scoped id (`/me` → `id`). Kept for diagnosis only. */
    scopedId: string | null;
    username: string | null;
    name: string | null;
    profilePictureUrl: string | null;
    accountType: string | null;
    /** Encrypted — this may sit in Redis between two requests. */
    accessToken: string;
    tokenIssuedAt: string;
    tokenExpiresAt: string;
    scopes: string[];
}

/**
 * Parked mid-flow state. Instagram Login grants exactly one account, so the
 * current flow never parks; the picker routes stay so a stale link fails with a
 * clean "expired" instead of a 500.
 */
interface InstagramPendingSelection {
    userId: string;
    orgId: string;
    reconnectChannelId?: string;
    candidates: InstagramCandidate[];
}

/** What `listPending` returns — display fields only, never a token. */
export type InstagramCandidateView = Pick<
    InstagramCandidate,
    'igUserId' | 'username' | 'name' | 'profilePictureUrl' | 'accountType'
>;

interface InstagramProfile {
    id?: string;
    user_id?: string | number;
    username?: string;
    name?: string;
    profile_picture_url?: string;
    account_type?: string;
}

/** What `metadata.webhookSubscription` records about the last subscribe attempt. */
interface WebhookSubscriptionState {
    ok: boolean;
    fields: string[];
    error: string | null;
    at: string;
}

const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const CODE_EXCHANGE_URL = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH_HOST = 'https://graph.instagram.com';

/** Refused without these: the account would connect and then be unable to message. */
const REQUIRED_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];
const SCOPES = [...REQUIRED_SCOPES, 'instagram_business_manage_comments'];

const WEBHOOK_FIELDS = [
    'messages',
    'messaging_postbacks',
    'messaging_seen',
    'message_reactions',
    'comments',
];
/** `comments` needs Advanced Access, so a Standard-Access app retries without it. */
const WEBHOOK_FIELDS_WITHOUT_COMMENTS = WEBHOOK_FIELDS.filter((f) => f !== 'comments');

const OAUTH_FETCH_TIMEOUT_MS = 30_000;

function describeError(err: unknown): string {
    if (err instanceof MetaGraphError) {
        return `${err.httpStatus ?? 'network'} ${err.code}: ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class InstagramOAuthService {
    private readonly logger = new Logger(InstagramOAuthService.name);
    private readonly appId: string;
    private readonly appSecret: string;
    private readonly appUrl: string;
    private readonly graphVersion: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        private readonly encryption: EncryptionService,
        private readonly redis: RedisService,
        private readonly metaGraph: MetaGraphClient,
    ) {
        this.appId = this.config.get<string>('instagram.loginAppId') ?? '';
        this.appSecret = this.config.get<string>('instagram.loginAppSecret') ?? '';
        this.appUrl = this.config.get<string>('appUrl')!;
        this.graphVersion = this.config.get<string>('instagram.graphVersion') ?? 'v21.0';
    }

    private igUrl(path: string): string {
        return `${IG_GRAPH_HOST}/${this.graphVersion}${path}`;
    }

    private get redirectUri(): string {
        return `${this.appUrl}/api/v1/channels/instagram/callback`;
    }

    private get frontendUrl(): string {
        return this.config.get<string>('frontendUrl')!;
    }

    /** App wallet, then the Instagram account's own when it is known. */
    private scopes(igUserId?: string | null): RateLimitScope[] {
        return igUserId
            ? [...this.metaGraph.baseScopes(), metaScope.igUser(igUserId)]
            : this.metaGraph.baseScopes();
    }

    /**
     * Decrypt a stored secret, or null if it cannot be recovered.
     *
     * `EncryptionService.decrypt` fails in two different silent ways: it throws
     * on a null/undefined input, and returns the EMPTY STRING when the
     * ciphertext does not match the current ENCRYPTION_KEY. Callers need one
     * answer — "I have a usable token, or I do not" — because passing an empty
     * token on to Meta produces a connection that looks fine and does nothing.
     */
    private safeDecrypt(cipherText: unknown): string | null {
        if (typeof cipherText !== 'string' || !cipherText) return null;
        try {
            return this.encryption.decrypt(cipherText) || null;
        } catch {
            return null;
        }
    }

    /**
     * One OAuth-flow call through the shared, rate-limited Meta client.
     *
     * A rate limit propagates as `RateLimitedError` (the HTTP filter turns it
     * into a 503 with Retry-After); anything else becomes one generic 400,
     * with Meta's own words kept in the log.
     */
    private async oauthCall<T>(req: Omit<MetaRequest, 'scopes'>, what: string): Promise<T> {
        try {
            const res = await this.metaGraph.request<T>({
                priority: Priority.INTERACTIVE,
                timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
                ...req,
                scopes: this.scopes(),
            });
            return res.data;
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            this.logger.error(`Instagram ${what} failed: ${describeError(err)}`);
            throw new BadRequestException('Instagram could not be reached. Please try again.');
        }
    }

    /** The org's Instagram rows, in the narrow shape the decision helpers want. */
    private async instagramRows(orgId: string) {
        return this.prisma.channel.findMany({
            where: { organizationId: orgId, platform: ChannelPlatform.INSTAGRAM },
            select: {
                id: true,
                platform: true,
                status: true,
                externalStoreId: true,
                metadata: true,
                ownerUserId: true,
            },
        });
    }

    // ─── STEP 1: build the Instagram Login URL ───────────────────────────────

    /**
     * An org may connect many Instagram accounts, so unlike Shopify there is no
     * limit to enforce here — only an explicit reconnect target to validate.
     * Which account signs in is decided inside Instagram's UI, so duplicates can
     * only be caught on the way back, in `connectCandidate`.
     */
    async getInstallUrl(
        orgId: string,
        userId: string,
        reconnectChannelId?: string,
    ): Promise<string> {
        if (!this.appId || !this.appSecret) {
            throw new BadRequestException(
                'Instagram is not configured on the server. Missing INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET.',
            );
        }

        const rows = await this.instagramRows(orgId);
        const decision = assertCanConnect(rows, ChannelPlatform.INSTAGRAM, reconnectChannelId);
        if (decision.kind === 'blocked') {
            throw new ConflictException(decision.message);
        }

        const state = randomBytes(16).toString('hex');
        await this.redis.set(
            `${REDIS_KEYS.OAUTH_INSTAGRAM}${state}`,
            { userId, orgId, reconnectChannelId } satisfies InstagramOAuthState,
            REDIS_TTL.OAUTH_STATE,
        );

        const url = new URL(AUTHORIZE_URL);
        url.searchParams.set('client_id', this.appId);
        url.searchParams.set('redirect_uri', this.redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', SCOPES.join(','));
        url.searchParams.set('state', state);
        // Otherwise Instagram silently reuses whichever account the browser is
        // signed into, and connecting a second account becomes impossible.
        url.searchParams.set('force_reauth', 'true');
        return url.toString();
    }

    // ─── STEP 2: the callback ────────────────────────────────────────────────

    /**
     * Handle Instagram's redirect back.
     *
     * Returns the frontend URL to send the merchant's browser to.
     */
    async handleCallback(query: {
        code?: string;
        state?: string;
        error?: string;
        error_reason?: string;
        error_description?: string;
    }): Promise<{ channelId?: string; redirectUrl: string }> {
        // A denied or abandoned login comes back with NO code at all, just an
        // error triplet. Consume the state anyway so the nonce cannot be reused.
        if (!query.code) {
            if (query.state) {
                await this.redis.del(`${REDIS_KEYS.OAUTH_INSTAGRAM}${query.state}`);
            }
            throw new BadRequestException('Authorization was cancelled.');
        }

        const stateKey = `${REDIS_KEYS.OAUTH_INSTAGRAM}${query.state ?? ''}`;
        const stateData = await this.redis.get<InstagramOAuthState>(stateKey);
        if (!stateData) {
            throw new UnauthorizedException('Invalid or expired state parameter');
        }
        await this.redis.del(stateKey);

        // Instagram appends `#_` to the code; it is not part of it.
        const code = query.code.replace(/#_$/, '');

        // 1. Code → short-lived token. This endpoint only accepts a form body.
        const grant = readTokenGrant(
            await this.oauthCall<unknown>(
                {
                    method: 'POST',
                    url: CODE_EXCHANGE_URL,
                    form: {
                        client_id: this.appId,
                        client_secret: this.appSecret,
                        grant_type: 'authorization_code',
                        redirect_uri: this.redirectUri,
                        code,
                    },
                },
                'code exchange',
            ),
        );
        if (!grant?.access_token) {
            throw new BadRequestException('Instagram did not return an access token. Please try again.');
        }

        // Instagram's consent screen lets the user untick permissions. Without
        // messaging the account would "connect" and then never work.
        const granted = normaliseGrantedScopes(grant.permissions);
        const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
        if (granted.length > 0 && missing.length > 0) {
            throw new BadRequestException(
                `Instagram permissions were declined (${missing.join(', ')}). Allow them to connect the account.`,
            );
        }

        // 2. Short-lived → long-lived (60 day) token. Both token endpoints take
        //    the token as a query parameter and nothing else; the client logs
        //    only the path, never the query.
        const tokenIssuedAt = new Date();
        const longLived = await this.oauthCall<{ access_token?: string; expires_in?: number }>(
            {
                method: 'GET',
                url: `${IG_GRAPH_HOST}/access_token`,
                query: {
                    grant_type: 'ig_exchange_token',
                    client_secret: this.appSecret,
                    access_token: grant.access_token,
                },
            },
            'long-lived token exchange',
        );
        if (!longLived.access_token) {
            throw new BadRequestException('Instagram did not return an access token. Please try again.');
        }
        const tokenExpiresAt = new Date(
            tokenIssuedAt.getTime() +
                (longLived.expires_in || INSTAGRAM_LONG_LIVED_FALLBACK_S) * 1000,
        );

        // 3. Who signed in.
        const profile = await this.oauthCall<InstagramProfile>(
            {
                method: 'GET',
                url: this.igUrl('/me'),
                query: { fields: 'user_id,username,name,profile_picture_url,account_type' },
                accessToken: longLived.access_token,
            },
            'profile lookup',
        );

        // Diagnostic for the switch from Facebook Login: `user_id` must be the
        // same professional-account id the old flow stored, or existing rows
        // will not be recognised on reconnect. The token-exchange `user_id` is
        // a JSON number and can lose precision, so it is logged, never used.
        this.logger.log(
            `Instagram Login profile: user_id=${profile.user_id} app-scoped id=${profile.id} ` +
            `token-exchange user_id=${grant.user_id} account_type=${profile.account_type} ` +
            `granted=[${granted.join(',')}]`,
        );

        if (profile.user_id === undefined || profile.user_id === null || profile.user_id === '') {
            throw new BadRequestException('Instagram did not return the account id. Please try again.');
        }
        if (typeof profile.user_id === 'number') {
            this.logger.warn(
                `Instagram returned user_id as a number (${profile.user_id}); ids past 2^53 lose precision.`,
            );
        }
        if (profile.account_type && !PROFESSIONAL_ACCOUNT_TYPES.includes(profile.account_type)) {
            throw new BadRequestException(
                'Only Instagram Business or Creator accounts can be connected. Switch the account to a professional account and try again.',
            );
        }

        const candidate: InstagramCandidate = {
            igUserId: String(profile.user_id),
            scopedId: profile.id ?? null,
            username: profile.username ?? null,
            name: profile.name ?? null,
            profilePictureUrl: profile.profile_picture_url ?? null,
            accountType: profile.account_type ?? null,
            accessToken: this.encryption.encrypt(longLived.access_token),
            tokenIssuedAt: tokenIssuedAt.toISOString(),
            tokenExpiresAt: tokenExpiresAt.toISOString(),
            scopes: granted.length > 0 ? granted : SCOPES,
        };

        const result = await this.connectCandidate(
            stateData.orgId,
            candidate,
            stateData.reconnectChannelId,
            // Whoever started the flow owns what it connects — carried in the
            // OAuth state because the callback has no session.
            stateData.userId,
        );
        return {
            channelId: result.channelId,
            redirectUrl:
                `${this.frontendUrl}/settings/channels?connected=instagram` +
                `&channelId=${result.channelId}` +
                (result.sameAccount ? '&note=refreshed' : ''),
        };
    }

    // ─── Legacy account picker ───────────────────────────────────────────────

    /** The parked candidates, with every token stripped out. */
    async listPending(
        pendingId: string,
        orgId: string,
    ): Promise<{ pendingId: string; candidates: InstagramCandidateView[] }> {
        const pending = await this.readPending(pendingId, orgId);
        return {
            pendingId,
            candidates: pending.candidates.map((c) => ({
                igUserId: c.igUserId,
                username: c.username,
                name: c.name,
                profilePictureUrl: c.profilePictureUrl,
                accountType: c.accountType,
            })),
        };
    }

    /** Connect the account the merchant picked, then burn the pending state. */
    async completePending(
        pendingId: string,
        igUserId: string,
        orgId: string,
        connectingUserId?: string,
    ): Promise<{ channelId: string; account: ChannelAccountSummary | null }> {
        const pending = await this.readPending(pendingId, orgId);
        const candidate = pending.candidates.find((c) => c.igUserId === igUserId);
        if (!candidate) {
            throw new NotFoundException('That account was not part of this connection.');
        }

        const result = await this.connectCandidate(
            orgId,
            candidate,
            pending.reconnectChannelId,
            // Prefer the signed-in caller; fall back to whoever began the flow.
            connectingUserId ?? pending.userId,
        );
        await this.redis.del(`${REDIS_KEYS.OAUTH_INSTAGRAM_PENDING}${pendingId}`);
        return { channelId: result.channelId, account: result.account };
    }

    private async readPending(
        pendingId: string,
        orgId: string,
    ): Promise<InstagramPendingSelection> {
        const pending = await this.redis.get<InstagramPendingSelection>(
            `${REDIS_KEYS.OAUTH_INSTAGRAM_PENDING}${pendingId}`,
        );
        // An org mismatch reads as "not found" rather than 403: it is either an
        // expired key or someone else's, and neither is this org's business.
        // A pre-Instagram-Login entry has no `accessToken`; treat it as expired.
        if (!pending || pending.orgId !== orgId || !pending.candidates?.every((c) => c.accessToken)) {
            throw new NotFoundException(
                'This Instagram selection has expired. Start the connection again.',
            );
        }
        return pending;
    }

    // ─── Writing the channel row ─────────────────────────────────────────────

    /**
     * Create or revive the Channel row for one Instagram account.
     *
     * Re-decides create-vs-reconnect here rather than trusting the decision made
     * before the redirect: the merchant spent the intervening seconds inside
     * Instagram, during which another tab — or another admin — may have
     * connected the very account they signed in with.
     */
    private async connectCandidate(
        orgId: string,
        candidate: InstagramCandidate,
        reconnectChannelId?: string,
        /** The member connecting. Recorded as the channel's owner. */
        connectingUserId?: string,
    ): Promise<{
        channelId: string;
        sameAccount: boolean;
        account: ChannelAccountSummary | null;
    }> {
        const rows = await this.instagramRows(orgId);
        const decision = resolveConnectTarget(
            rows,
            ChannelPlatform.INSTAGRAM,
            candidate.igUserId,
            reconnectChannelId,
            connectingUserId,
        );
        if (decision.kind === 'blocked') {
            throw new ConflictException(decision.message);
        }

        // Reconnect UPDATES an existing row, so its metadata has to be merged
        // into rather than replaced — overwriting it would drop whatever else
        // the row carries there. Mirrors the merge in ChannelService.disconnect.
        const existingMeta =
            decision.kind === 'reconnect'
                ? ((rows.find((r) => r.id === decision.channelId)?.metadata ??
                    {}) as Record<string, unknown>)
                : {};

        // Recover the token BEFORE writing anything. A value that does not
        // decrypt under the current ENCRYPTION_KEY comes back as the empty
        // string, which would store a channel whose token cannot work and
        // report it to the merchant as success.
        const token = this.safeDecrypt(candidate.accessToken);
        if (!token) {
            this.logger.error(
                `Instagram connect aborted: token for ${candidate.igUserId} is missing or undecryptable`,
            );
            throw new BadRequestException(
                'Could not complete the Instagram connection securely. Please start it again.',
            );
        }

        const webhookSubscription = await this.subscribeWebhooks(candidate.igUserId, token);

        const credentials = {
            authFlow: INSTAGRAM_LOGIN_FLOW,
            accessToken: candidate.accessToken,
            instagramUserId: candidate.igUserId,
            instagramScopedId: candidate.scopedId,
            instagramUsername: candidate.username,
            name: candidate.name,
            profilePictureUrl: candidate.profilePictureUrl,
            accountType: candidate.accountType,
            tokenIssuedAt: candidate.tokenIssuedAt,
            tokenExpiresAt: candidate.tokenExpiresAt,
            scopes: candidate.scopes.join(','),
        };
        const account = describeAccount(ChannelPlatform.INSTAGRAM, credentials, null);

        const data = {
            name: candidate.username ? `@${candidate.username}` : candidate.name ?? 'Instagram',
            status: ChannelStatus.CONNECTED,
            isEnabled: true,
            credentials: credentials as unknown as Prisma.InputJsonValue,
            externalStoreId: candidate.igUserId,
            externalStoreUrl: candidate.username
                ? `https://instagram.com/${candidate.username}`
                : null,
            connectedAt: new Date(),
            lastError: null,
            syncStatus: SyncStatus.IDLE,
            // Who this account belongs to. For an influencer this IS the
            // Organization -> Influencer -> Instagram relationship, and it is
            // what confines them to their own connections everywhere else.
            ...(connectingUserId ? { ownerUserId: connectingUserId } : {}),
            metadata: {
                ...existingMeta,
                externalAccountId: candidate.igUserId,
                lastAccount: account,
                // Recorded instead of swallowed: "connected" must not be
                // mistaken for "messages will arrive".
                webhookSubscription,
                // The row is live again; leaving a stale disconnect date would
                // make the UI label a connected account "Disconnected <date>".
                disconnectedAt: null,
            } as unknown as Prisma.InputJsonValue,
        };

        try {
            const channel =
                decision.kind === 'reconnect'
                    ? await this.prisma.channel.update({
                        where: { id: decision.channelId },
                        data,
                    })
                    : await this.prisma.channel.create({
                        data: {
                            ...data,
                            organizationId: orgId,
                            platform: ChannelPlatform.INSTAGRAM,
                        },
                    });

            this.logger.log(
                `Instagram ${decision.kind === 'reconnect' ? 'reconnected' : 'connected'}: ` +
                `@${candidate.username ?? candidate.igUserId} → org ${orgId} (channel ${channel.id}); ` +
                `webhooks ${webhookSubscription.ok ? `subscribed [${webhookSubscription.fields.join(',')}]` : 'NOT subscribed'}`,
            );

            return {
                channelId: channel.id,
                sameAccount: decision.kind === 'reconnect' && decision.sameAccount,
                account,
            };
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                // (platform, external_store_id) is unique across the WHOLE
                // table, so some row already claims this account. Which row is
                // worth finding out: assuming "another organization" sends the
                // merchant hunting through orgs they may not even own, when the
                // holder is often a row in this very org that resolveConnectTarget
                // did not match (a disconnected row still holding the id, or one
                // owned by a different user).
                const holder = await this.prisma.channel.findFirst({
                    where: {
                        platform: ChannelPlatform.INSTAGRAM,
                        externalStoreId: candidate.igUserId,
                    },
                    select: {
                        name: true,
                        organizationId: true,
                        organization: { select: { name: true } },
                    },
                });
                const label = candidate.username ? `@${candidate.username}` : 'This Instagram account';
                // Keep the words "another organization" for the genuine cross-org
                // case — classifyMetaCallbackError matches on them to pick the
                // `account_taken` redirect reason.
                throw new ConflictException(
                    !holder
                        ? `${label} is already connected. Disconnect it first.`
                        : holder.organizationId === orgId
                          ? `${label} is already connected in this organization as "${holder.name}". Disconnect that channel first.`
                          : `${label} is already connected to another organization ("${holder.organization?.name ?? holder.organizationId}"). Disconnect it there first.`,
                );
            }
            throw error;
        }
    }

    /**
     * Subscribe the account to webhook fields. Never fails the connect — a
     * connected account that is not subscribed still authenticates — but the
     * outcome is returned so it can be stored and seen.
     */
    private async subscribeWebhooks(igUserId: string, token: string): Promise<WebhookSubscriptionState> {
        let firstError: string | null = null;
        for (const fields of [WEBHOOK_FIELDS, WEBHOOK_FIELDS_WITHOUT_COMMENTS]) {
            try {
                await this.metaGraph.request({
                    method: 'POST',
                    url: this.igUrl('/me/subscribed_apps'),
                    query: { subscribed_fields: fields.join(',') },
                    accessToken: token,
                    scopes: this.scopes(igUserId),
                    priority: Priority.INTERACTIVE,
                    timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
                });
                return { ok: true, fields, error: firstError, at: new Date().toISOString() };
            } catch (err) {
                const message = describeError(err);
                firstError ??= message;
                this.logger.warn(
                    `Instagram webhook subscription for ${igUserId} failed with [${fields.join(',')}]: ${message}`,
                );
            }
        }
        return { ok: false, fields: [], error: firstError, at: new Date().toISOString() };
    }

    // ─── Token upkeep ────────────────────────────────────────────────────────

    /** A decrypted token for API calls, refreshing the grant when it is nearly up. */
    async getAccessToken(channelId: string): Promise<{ token: string; igUserId: string }> {
        const channel = await this.prisma.channel.findUnique({
            where: { id: channelId },
            select: { credentials: true },
        });
        const creds = (channel?.credentials ?? null) as Record<string, unknown> | null;
        if (!creds) {
            throw new BadRequestException('Channel not found or missing credentials');
        }

        if (creds.authFlow !== INSTAGRAM_LOGIN_FLOW) {
            await this.markNeedsReconnect(
                channelId,
                'This Instagram account was connected with Facebook Login. Reconnect it to sign in with Instagram.',
            );
            throw new BadRequestException('Instagram channel must be reconnected');
        }

        const now = new Date();
        if (isInstagramTokenExpired(creds, now)) {
            await this.markNeedsReconnect(
                channelId,
                'Instagram access expired. Reconnect the account.',
            );
            throw new BadRequestException('Instagram access expired');
        }
        if (isInstagramTokenRefreshDue(creds, now, INSTAGRAM_REFRESH_AHEAD_MS)) {
            await this.refreshToken(channelId, Priority.INTERACTIVE);
            return this.getAccessToken(channelId);
        }

        const token = this.safeDecrypt(creds.accessToken);
        if (!token) {
            await this.markNeedsReconnect(
                channelId,
                'The stored Instagram access could not be read. Reconnect the account.',
            );
            throw new BadRequestException('Instagram channel must be reconnected');
        }
        return { token, igUserId: String(creds.instagramUserId) };
    }

    /**
     * Swap the long-lived token for a fresh 60-day one.
     *
     * Only a token Meta actually rejected marks the channel ERROR; a timeout or
     * a 5xx leaves it alone for the next attempt, and a rate limit propagates
     * as such rather than branding the channel as needing a reconnect.
     */
    async refreshToken(channelId: string, priority: Priority = Priority.NORMAL): Promise<void> {
        const channel = await this.prisma.channel.findUnique({
            where: { id: channelId },
            select: { credentials: true },
        });
        const creds = (channel?.credentials ?? {}) as Record<string, unknown>;
        const current = this.safeDecrypt(creds.accessToken);
        if (!current) {
            await this.markNeedsReconnect(
                channelId,
                'The stored Instagram access could not be read. Reconnect the account.',
            );
            throw new BadRequestException('Failed to refresh Instagram token');
        }

        let data: { access_token?: string; expires_in?: number };
        try {
            const res = await this.metaGraph.request<{ access_token?: string; expires_in?: number }>({
                method: 'GET',
                url: `${IG_GRAPH_HOST}/refresh_access_token`,
                query: { grant_type: 'ig_refresh_token', access_token: current },
                scopes: this.scopes(typeof creds.instagramUserId === 'string' ? creds.instagramUserId : null),
                priority,
                channelId,
                timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
            });
            data = res.data;
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            this.logger.error(
                `Instagram token refresh failed for channel ${channelId}: ${describeError(err)}`,
            );
            const rejected =
                err instanceof MetaGraphError &&
                (err.code === 'AUTH_FAILED' || err.code === 'API_ERROR' || err.code === 'HTTP_ERROR');
            if (rejected) {
                await this.markNeedsReconnect(
                    channelId,
                    'Instagram access expired and could not be renewed. Reconnect the account.',
                );
            }
            throw new BadRequestException('Failed to refresh Instagram token');
        }
        if (!data.access_token) {
            throw new BadRequestException('Failed to refresh Instagram token');
        }

        const issuedAt = new Date();
        const expiresAt = new Date(
            issuedAt.getTime() + (data.expires_in || INSTAGRAM_LONG_LIVED_FALLBACK_S) * 1000,
        );
        await this.prisma.channel.update({
            where: { id: channelId },
            data: {
                credentials: {
                    ...creds,
                    accessToken: this.encryption.encrypt(data.access_token),
                    tokenIssuedAt: issuedAt.toISOString(),
                    tokenExpiresAt: expiresAt.toISOString(),
                } as unknown as Prisma.InputJsonValue,
                status: ChannelStatus.CONNECTED,
                lastError: null,
            },
        });

        this.logger.log(
            `Instagram token refreshed for channel ${channelId}, expires ${expiresAt.toISOString()}`,
        );
    }

    private async markNeedsReconnect(channelId: string, lastError: string): Promise<void> {
        await this.prisma.channel.update({
            where: { id: channelId },
            // Shown verbatim on the channels page, so it says what to do.
            data: { status: ChannelStatus.ERROR, lastError },
        });
    }

    /**
     * Stop the account sending us webhooks.
     *
     * Best-effort by contract: called during disconnect, where the token may
     * already be dead and the local state must be cleared regardless.
     */
    async revokeWebhookSubscription(channel: {
        id: string;
        credentials: Prisma.JsonValue;
    }): Promise<void> {
        const creds = (channel.credentials ?? null) as Record<string, unknown> | null;
        if (!creds) return;

        try {
            if (creds.authFlow === INSTAGRAM_LOGIN_FLOW) {
                const token = this.safeDecrypt(creds.accessToken);
                if (!token) return;
                await this.metaGraph.request({
                    method: 'DELETE',
                    url: this.igUrl('/me/subscribed_apps'),
                    accessToken: token,
                    scopes: this.scopes(typeof creds.instagramUserId === 'string' ? creds.instagramUserId : null),
                    priority: Priority.INTERACTIVE,
                    channelId: channel.id,
                    timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
                });
                this.logger.log(`Instagram webhooks unsubscribed for channel ${channel.id}`);
                return;
            }

            // A row still on the old Facebook Login flow: the subscription
            // belongs to its Page.
            const pageId = typeof creds.pageId === 'string' ? creds.pageId : null;
            const pageToken = this.safeDecrypt(creds.pageAccessToken);
            if (!pageId || !pageToken) return;
            await this.metaGraph.request({
                method: 'DELETE',
                path: `/${pageId}/subscribed_apps`,
                accessToken: pageToken,
                scopes: [...this.metaGraph.baseScopes(), metaScope.page(pageId)],
                pageId,
                priority: Priority.INTERACTIVE,
                channelId: channel.id,
                timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
            });
        } catch (err) {
            this.logger.warn(
                `Could not unsubscribe webhooks for channel ${channel.id} — disconnecting anyway: ${describeError(err)}`,
            );
        }
    }
}
