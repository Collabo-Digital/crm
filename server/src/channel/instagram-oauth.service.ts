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
import {
    assertCanConnect,
    resolveConnectTarget,
    describeAccount,
    isActive,
    type ChannelAccountSummary,
} from './channel-connection.util';

/** OAuth state, keyed by the nonce we hand Meta. */
interface InstagramOAuthState {
    userId: string;
    orgId: string;
    reconnectChannelId?: string;
}

/** One Instagram business account reachable through the merchant's login. */
interface InstagramCandidate {
    igUserId: string;
    username: string | null;
    name: string | null;
    profilePictureUrl: string | null;
    pageId: string;
    pageName: string;
    /** Encrypted — this blob sits in Redis between two requests. */
    pageAccessToken: string;
}

/**
 * Parked mid-flow state: the merchant authorised a login that turned out to
 * grant several Instagram accounts, and has to say which one to connect.
 */
interface InstagramPendingSelection {
    userId: string;
    orgId: string;
    reconnectChannelId?: string;
    /** Encrypted. */
    userAccessToken: string;
    tokenExpiresAt: string;
    candidates: InstagramCandidate[];
}

/** What `listPending` returns — the same candidates minus every token. */
export type InstagramCandidateView = Omit<InstagramCandidate, 'pageAccessToken'>;

interface MetaPage {
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: {
        id: string;
        username?: string;
        name?: string;
        profile_picture_url?: string;
    };
}

const OAUTH_FETCH_TIMEOUT_MS = 30_000;
/** Stop following `paging.next` eventually, however many Pages exist. */
const MAX_PAGE_REQUESTS = 20;

@Injectable()
export class InstagramOAuthService {
    private readonly logger = new Logger(InstagramOAuthService.name);
    private readonly appId: string;
    private readonly appSecret: string;
    private readonly appUrl: string;
    private readonly graphVersion: string;
    private readonly scopes: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        private readonly encryption: EncryptionService,
        private readonly redis: RedisService,
    ) {
        this.appId = this.config.get<string>('instagram.appId')!;
        this.appSecret = this.config.get<string>('instagram.appSecret')!;
        this.appUrl = this.config.get<string>('appUrl')!;
        this.graphVersion = this.config.get<string>('instagram.graphVersion') ?? 'v21.0';
        this.scopes = [
            'instagram_basic',
            'instagram_manage_messages',
            'pages_show_list',
            'pages_messaging',
            'pages_read_engagement',
            'instagram_manage_comments',
        ].join(',');
    }

    private graphUrl(path: string): string {
        return `https://graph.facebook.com/${this.graphVersion}${path}`;
    }

    private get redirectUri(): string {
        return `${this.appUrl}/api/v1/channels/instagram/callback`;
    }

    private get frontendUrl(): string {
        return this.config.get<string>('frontendUrl')!;
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
    private safeDecrypt(cipherText: string | null | undefined): string | null {
        if (!cipherText) return null;
        try {
            return this.encryption.decrypt(cipherText) || null;
        } catch {
            return null;
        }
    }

    private async getJson<T>(url: string, init?: RequestInit): Promise<T> {
        const res = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
            const body = await res.text();
            this.logger.error(`Meta request failed (${res.status}): ${body}`);
            throw new BadRequestException('Instagram could not be reached. Please try again.');
        }
        return (await res.json()) as T;
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

    // ─── STEP 1: build the Facebook Login URL ────────────────────────────────

    /**
     * An org may connect many Instagram accounts, so unlike Shopify there is no
     * limit to enforce here — only an explicit reconnect target to validate.
     * Which account the merchant picks is decided inside Meta's UI, so
     * duplicates can only be caught on the way back, in `connectCandidate`.
     */
    async getInstallUrl(
        orgId: string,
        userId: string,
        reconnectChannelId?: string,
    ): Promise<string> {
        if (!this.appId || !this.appSecret) {
            throw new BadRequestException(
                'Instagram is not configured on the server. Missing META_APP_ID / META_APP_SECRET.',
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

        return (
            `https://www.facebook.com/${this.graphVersion}/dialog/oauth` +
            `?client_id=${this.appId}` +
            `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
            `&scope=${encodeURIComponent(this.scopes)}` +
            `&state=${state}`
        );
    }

    // ─── STEP 2: the callback ────────────────────────────────────────────────

    /**
     * Handle Meta's redirect back.
     *
     * Every success shape returns a frontend URL to redirect the merchant's
     * browser to — either the connected channel, or the account picker when the
     * login granted more than one Instagram account we could connect.
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

        // 1. Code → short-lived token → long-lived (60 day) token.
        const tokenData = await this.getJson<{ access_token: string; expires_in: number }>(
            this.graphUrl('/oauth/access_token') +
            `?client_id=${this.appId}` +
            `&client_secret=${this.appSecret}` +
            `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
            `&code=${encodeURIComponent(query.code)}`,
        );

        const longLived = await this.getJson<{ access_token: string; expires_in: number }>(
            this.graphUrl('/oauth/access_token') +
            `?grant_type=fb_exchange_token` +
            `&client_id=${this.appId}` +
            `&client_secret=${this.appSecret}` +
            `&fb_exchange_token=${tokenData.access_token}`,
        );
        const userToken = longLived.access_token;
        const tokenExpiresAt = new Date(
            Date.now() + (longLived.expires_in || 60 * 24 * 60 * 60) * 1000,
        );

        // 2. Every Page the merchant granted, with its Instagram account
        //    expanded inline. This used to read `pagesData.data[0]` — one Page,
        //    unpaginated — which is why a second account was unreachable.
        const pages = await this.fetchPages(userToken);
        if (pages.length === 0) {
            throw new BadRequestException(
                'No Facebook Pages found. Instagram connects through a Facebook Page, so you need at least one.',
            );
        }

        const candidates: InstagramCandidate[] = pages
            .filter((page) => page.instagram_business_account)
            .map((page) => ({
                igUserId: page.instagram_business_account!.id,
                username: page.instagram_business_account!.username ?? null,
                name: page.instagram_business_account!.name ?? null,
                profilePictureUrl: page.instagram_business_account!.profile_picture_url ?? null,
                pageId: page.id,
                pageName: page.name,
                pageAccessToken: this.encryption.encrypt(page.access_token),
            }));

        if (candidates.length === 0) {
            throw new BadRequestException(
                'No Instagram Business account found on your Facebook Pages. ' +
                'Make sure your Instagram account is a Business or Creator account linked to a Page.',
            );
        }

        // 3. Drop what this org already holds live. A DISCONNECTED match stays
        //    on the list — picking it revives that row rather than duplicating.
        const rows = await this.instagramRows(stateData.orgId);
        const liveIds = new Set(
            rows
                .filter((r) => isActive(r.status) && r.externalStoreId)
                .map((r) => r.externalStoreId!),
        );
        const selectable = candidates.filter((c) => !liveIds.has(c.igUserId));

        if (selectable.length === 0) {
            throw new ConflictException(
                candidates.length === 1
                    ? 'That Instagram account is already connected to this organization.'
                    : 'All of those Instagram accounts are already connected to this organization.',
            );
        }

        // 4. One choice — connect it. Several — let the merchant choose.
        if (selectable.length === 1) {
            const result = await this.connectCandidate(
                stateData.orgId,
                selectable[0],
                userToken,
                tokenExpiresAt,
                stateData.reconnectChannelId,
                // Whoever started the flow owns what it connects — carried in
                // the OAuth state because the callback has no session.
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

        const pendingId = randomBytes(16).toString('hex');
        await this.redis.set(
            `${REDIS_KEYS.OAUTH_INSTAGRAM_PENDING}${pendingId}`,
            {
                userId: stateData.userId,
                orgId: stateData.orgId,
                reconnectChannelId: stateData.reconnectChannelId,
                userAccessToken: this.encryption.encrypt(userToken),
                tokenExpiresAt: tokenExpiresAt.toISOString(),
                candidates: selectable,
            } satisfies InstagramPendingSelection,
            REDIS_TTL.OAUTH_STATE,
        );

        return {
            redirectUrl: `${this.frontendUrl}/settings/channels?select=instagram&pending=${pendingId}`,
        };
    }

    /** Every Page the token can see, following Meta's cursor pagination. */
    private async fetchPages(userToken: string): Promise<MetaPage[]> {
        const fields =
            'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}';
        let url =
            this.graphUrl('/me/accounts') +
            `?fields=${encodeURIComponent(fields)}&limit=100&access_token=${userToken}`;

        const pages: MetaPage[] = [];
        for (let request = 0; request < MAX_PAGE_REQUESTS && url; request++) {
            const body = await this.getJson<{
                data?: MetaPage[];
                paging?: { next?: string };
            }>(url);
            pages.push(...(body.data ?? []));
            url = body.paging?.next ?? '';
        }
        return pages;
    }

    // ─── STEP 3: the account picker ──────────────────────────────────────────

    /** The parked candidates, with every token stripped out. */
    async listPending(
        pendingId: string,
        orgId: string,
    ): Promise<{ pendingId: string; candidates: InstagramCandidateView[] }> {
        const pending = await this.readPending(pendingId, orgId);
        return {
            pendingId,
            candidates: pending.candidates.map(({ pageAccessToken, ...view }) => view),
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

        const userToken = this.safeDecrypt(pending.userAccessToken);
        if (!userToken) {
            this.logger.error(
                `Instagram selection ${pendingId} holds a user token that cannot be decrypted`,
            );
            throw new BadRequestException(
                'Could not complete the Instagram connection securely. Please start it again.',
            );
        }

        const result = await this.connectCandidate(
            orgId,
            candidate,
            userToken,
            new Date(pending.tokenExpiresAt),
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
        if (!pending || pending.orgId !== orgId) {
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
     * Meta, during which another tab — or another admin — may have connected the
     * very account they picked.
     */
    private async connectCandidate(
        orgId: string,
        candidate: InstagramCandidate,
        userToken: string,
        tokenExpiresAt: Date,
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

        // Recover the Page token BEFORE writing anything.
        //
        // Both failure modes here are silent by default and must not be: an
        // absent value makes CryptoJS throw (an opaque 500 for the merchant),
        // and a value that does not decrypt under the current ENCRYPTION_KEY
        // comes back as the empty string — which would sail through and store a
        // channel whose token cannot work, reported to the merchant as success.
        const pageToken = candidate.pageAccessToken
            ? this.safeDecrypt(candidate.pageAccessToken)
            : null;
        if (!pageToken) {
            this.logger.error(
                `Instagram connect aborted: page token for ${candidate.pageId} is missing or undecryptable`,
            );
            throw new BadRequestException(
                'Could not complete the Instagram connection securely. Please start it again.',
            );
        }

        // Subscribe the Page to messaging webhooks. Non-fatal: a channel that is
        // connected but not subscribed still works for everything except inbound
        // DMs, and failing the whole connect over it would be the worse outcome.
        try {
            const subscribed = await fetch(
                this.graphUrl(`/${candidate.pageId}/subscribed_apps`) +
                `?subscribed_fields=messages,messaging_postbacks&access_token=${pageToken}`,
                { method: 'POST', signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS) },
            );
            if (!subscribed.ok) {
                // A non-OK response is the common case (permissions), and fetch
                // does not throw for it — without this check the warning below
                // could only ever fire on a network error.
                this.logger.warn(
                    `Instagram connected but Page ${candidate.pageId} was not subscribed ` +
                    `(${subscribed.status}): inbound DMs will not arrive until it is.`,
                );
            }
        } catch {
            this.logger.warn(
                `Instagram connected but webhook subscription failed for Page ${candidate.pageId}`,
            );
        }

        const credentials = {
            userAccessToken: this.encryption.encrypt(userToken),
            pageAccessToken: candidate.pageAccessToken,
            pageId: candidate.pageId,
            pageName: candidate.pageName,
            instagramUserId: candidate.igUserId,
            instagramUsername: candidate.username,
            profilePictureUrl: candidate.profilePictureUrl,
            tokenExpiresAt: tokenExpiresAt.toISOString(),
            scopes: this.scopes,
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
                `@${candidate.username ?? candidate.igUserId} → org ${orgId}`,
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
                // (platform, external_store_id) is unique across the whole
                // table, so this is another ORGANIZATION holding the account.
                throw new ConflictException(
                    'This Instagram account is already connected to another organization. Disconnect it there first.',
                );
            }
            throw error;
        }
    }

    // ─── Token upkeep ────────────────────────────────────────────────────────

    /** Decrypted tokens for API calls, refreshing the grant when it is nearly up. */
    async getAccessToken(
        channelId: string,
    ): Promise<{ token: string; pageToken: string; igUserId: string }> {
        const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
        if (!channel || !channel.credentials) {
            throw new BadRequestException('Channel not found or missing credentials');
        }

        const creds = channel.credentials as unknown as {
            userAccessToken: string;
            pageAccessToken: string;
            instagramUserId: string;
            tokenExpiresAt: string;
        };

        // Check if token needs refresh (within 7 days of expiry)
        const expiresAt = new Date(creds.tokenExpiresAt);
        const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        if (expiresAt < sevenDaysFromNow) {
            await this.refreshToken(channelId, creds);
            // Re-read after refresh
            return this.getAccessToken(channelId);
        }

        return {
            token: this.encryption.decrypt(creds.userAccessToken),
            pageToken: this.encryption.decrypt(creds.pageAccessToken),
            igUserId: creds.instagramUserId,
        };
    }

    private async refreshToken(
        channelId: string,
        creds: { userAccessToken: string; tokenExpiresAt: string },
    ): Promise<void> {
        const currentToken = this.encryption.decrypt(creds.userAccessToken);

        const res = await fetch(
            this.graphUrl('/oauth/access_token') +
            `?grant_type=fb_exchange_token` +
            `&client_id=${this.appId}` +
            `&client_secret=${this.appSecret}` +
            `&fb_exchange_token=${currentToken}`,
            { signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS) },
        );
        if (!res.ok) {
            this.logger.error(`Instagram token refresh failed for channel ${channelId}`);
            await this.prisma.channel.update({
                where: { id: channelId },
                data: {
                    status: ChannelStatus.ERROR,
                    // Shown verbatim on the channels page, so it has to say what
                    // the merchant should actually do about it.
                    lastError:
                        'Instagram access expired and could not be renewed. Reconnect the account.',
                },
            });
            throw new BadRequestException('Failed to refresh Instagram token');
        }

        const data = (await res.json()) as { access_token: string; expires_in: number };
        const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);

        // Re-fetch page access token with new user token
        const pagesData = await this.getJson<{ data?: Array<{ id: string; access_token: string }> }>(
            this.graphUrl('/me/accounts') + `?access_token=${data.access_token}`,
        );

        const existingChannel = await this.prisma.channel.findUnique({ where: { id: channelId } });
        const existingCreds = (existingChannel?.credentials ?? {}) as Record<string, unknown>;
        const pageId = existingCreds.pageId as string;
        const newPage = pagesData.data?.find((p) => p.id === pageId);

        await this.prisma.channel.update({
            where: { id: channelId },
            data: {
                credentials: {
                    ...existingCreds,
                    userAccessToken: this.encryption.encrypt(data.access_token),
                    pageAccessToken: newPage
                        ? this.encryption.encrypt(newPage.access_token)
                        : (existingCreds.pageAccessToken as string),
                    tokenExpiresAt: newExpiresAt.toISOString(),
                } as unknown as Prisma.InputJsonValue,
                status: ChannelStatus.CONNECTED,
                lastError: null,
            },
        });

        this.logger.log(
            `Instagram token refreshed for channel ${channelId}, expires ${newExpiresAt.toISOString()}`,
        );
    }

    /**
     * Stop the Page sending us webhooks.
     *
     * Best-effort by contract: called during disconnect, where the token may
     * already be dead and the local state must be cleared regardless.
     */
    async revokeWebhookSubscription(channel: {
        id: string;
        credentials: Prisma.JsonValue;
    }): Promise<void> {
        const creds = (channel.credentials ?? null) as {
            pageId?: string;
            pageAccessToken?: string;
        } | null;
        if (!creds?.pageId || !creds.pageAccessToken) return;

        try {
            const pageToken = this.safeDecrypt(creds.pageAccessToken);
            if (!pageToken) return;
            await fetch(
                this.graphUrl(`/${creds.pageId}/subscribed_apps`) + `?access_token=${pageToken}`,
                { method: 'DELETE', signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS) },
            );
        } catch {
            this.logger.warn(
                `Could not unsubscribe Page ${creds.pageId} for channel ${channel.id} — disconnecting anyway.`,
            );
        }
    }
}
