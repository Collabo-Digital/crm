import {
    Injectable,
    ConflictException,
    BadRequestException,
    UnauthorizedException,
    ServiceUnavailableException,
    Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus, SyncStatus, Prisma } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { REDIS_TTL } from '../redis/redis.constants';
import { EncryptionService } from './encryption.service';
import { ShopifyPushEnqueuer } from './shopify-push.enqueuer';
import { ShopifyGraphqlClient, ShopifyGraphqlError } from './shopify-graphql.client';
import {
    SHOP_INFO_QUERY,
    ShopInfoResponse,
    WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
    WebhookSubscriptionCreateResponse,
    WebhookSubscriptionCreateVariables,
    WEBHOOK_SUBSCRIPTIONS_QUERY,
    WebhookSubscriptionsListResponse,
    WEBHOOK_SUBSCRIPTION_DELETE_MUTATION,
    WebhookSubscriptionDeleteResponse,
} from './shopify-graphql.types';

import { missingScopes, ShopifyScopeStatus } from './shopify-scopes.util';

/// Hard limit on the OAuth token exchange and refresh calls. Neither had one,
/// so both were bounded only by undici's ~300s default — and the refresh runs
/// while holding a 15s Redis lock.
const OAUTH_FETCH_TIMEOUT_MS = 30_000;

@Injectable()
export class ShopifyOAuthService {
    private readonly logger = new Logger(ShopifyOAuthService.name);
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly scopes: string;
    private readonly appUrl: string;
    private readonly apiVersion: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        private readonly encryption: EncryptionService,
        private readonly redis: RedisService,
        private readonly shopifyPushEnqueuer: ShopifyPushEnqueuer,
        private readonly graphql: ShopifyGraphqlClient,
    ) {
        this.clientId = this.config.get<string>('shopify.clientId')!;
        this.clientSecret = this.config.get<string>('shopify.clientSecret')!;
        // Scope list comes from config (SHOPIFY_SCOPES) and MUST mirror the
        // [access_scopes] block in the public app's shopify.app.toml — with
        // include_config_on_deploy the deployed TOML is what Shopify actually
        // grants, regardless of the scope param in the authorize URL.
        // Existing tokens are pinned to the scopes they were issued with;
        // merchants must reconnect (re-run the install redirect) to pick up
        // newly added scopes.
        this.scopes = this.config.get<string>('shopify.scopes')!;
        this.appUrl = this.config.get<string>('appUrl')!;
        this.apiVersion = this.config.get<string>('shopify.apiVersion') ?? '2026-01';
    }

    // ─── PUBLIC APP OAUTH ───
    // The CRM's public Shopify app (created in the Partner Dashboard) is
    // installed into the merchant's store. The merchant only supplies their
    // shop domain — client_id/client_secret are platform-level env config.
    // The authorization-code grant issues a permanent OFFLINE access token
    // (no grant_options[] param), which only dies when the merchant
    // uninstalls the app or the app's client secret is rotated.

    // Accepts "my-store", "my-store.myshopify.com", or a full admin URL and
    // returns the canonical "my-store.myshopify.com" — or throws.
    private normalizeShopDomain(input: string): string {
        let domain = input
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, '');
        if (!domain.includes('.')) domain = `${domain}.myshopify.com`;
        if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
            throw new BadRequestException(
                'Enter your myshopify.com store domain, e.g. "my-store" or "my-store.myshopify.com"',
            );
        }
        return domain;
    }

    // Step 1: Generate the Shopify authorization URL.
    //
    // Two credential modes:
    //   • No apiKey/apiSecret → the platform's PUBLIC app (env
    //     SHOPIFY_CLIENT_ID/SECRET).
    //   • apiKey+apiSecret provided → a merchant-supplied CUSTOM app
    //     (Partner Dashboard custom distribution). The OAuth dance runs with
    //     those credentials, and they are persisted (encrypted) on the channel
    //     so webhook HMAC verification and token refresh work per channel.
    async getInstallUrl(
        orgId: string,
        userId: string,
        rawShopDomain: string,
        apiKey?: string,
        apiSecret?: string,
    ): Promise<string> {
        const customKey = apiKey?.trim() || undefined;
        const customSecret = apiSecret?.trim() || undefined;
        if ((customKey && !customSecret) || (!customKey && customSecret)) {
            throw new BadRequestException(
                'Provide BOTH the Client ID and Client Secret of your custom app, or neither.',
            );
        }
        if (!customKey && (!this.clientId || !this.clientSecret)) {
            throw new ServiceUnavailableException(
                'Shopify app credentials are not configured (SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)',
            );
        }
        const shopDomain = this.normalizeShopDomain(rawShopDomain);

        // One CRM org per store — (platform, externalStoreId) is globally
        // unique and webhook routing is by shop domain, so ANY other org's
        // channel row holding this store blocks the connect. Disconnecting in
        // that org releases the claim (clears the store ids).
        const takenByOtherOrg = await this.prisma.channel.findFirst({
            where: {
                platform: ChannelPlatform.SHOPIFY,
                externalStoreUrl: `https://${shopDomain}`,
                organizationId: { not: orgId },
            },
            select: { id: true },
        });
        if (takenByOtherOrg) {
            throw new ConflictException(
                'This Shopify store is already linked to another organization. Disconnect it there first.',
            );
        }

        // A DISCONNECTED channel (app uninstalled / dead token) may
        // reconnect — the callback then updates the row instead of creating
        // a duplicate (which would trip the org+platform unique constraint).
        const existing = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.SHOPIFY },
        });
        if (existing && existing.status === ChannelStatus.CONNECTED && existing.credentials) {
            // Same shop re-authing (e.g. to grant newly added scopes) is fine —
            // the callback updates the row via reconnectChannelId. Only block
            // connecting a DIFFERENT shop while one is already connected.
            const sameShop = existing.externalStoreUrl === `https://${shopDomain}`;
            if (!sameShop) {
                throw new ConflictException('This organization already has a Shopify store connected');
            }
        }

        const state = randomBytes(16).toString('hex');
        // Custom-app credentials ride in the short-lived state (10-min TTL,
        // deleted on first use) so the callback can verify the HMAC and
        // exchange the code with the right app identity.
        await this.redis.set(`oauth:shopify:${state}`, {
            userId, orgId, shopDomain,
            reconnectChannelId: existing?.id,
            ...(customKey && customSecret
                ? { clientId: customKey, clientSecret: customSecret }
                : {}),
        }, REDIS_TTL.OAUTH_STATE);

        const redirectUri = `${this.appUrl}/api/v1/channels/shopify/callback`;

        return (
            `https://${shopDomain}/admin/oauth/authorize` +
            `?client_id=${customKey ?? this.clientId}` +
            `&scope=${this.scopes}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&state=${state}`
        );
    }

    // Step 2: Handle the OAuth callback from Shopify
    async handleCallback(query: {
        code?: string;
        hmac: string;
        shop: string;
        state: string;
        timestamp: string;
    }): Promise<{ channelId: string; organizationId: string; redirectUrl: string }> {
        // 1. Validate + consume CSRF state
        const stateData = await this.redis.get<{
            userId: string; orgId: string; shopDomain: string;
            reconnectChannelId?: string;
            clientId?: string; clientSecret?: string;
        }>(`oauth:shopify:${query.state}`);
        if (!stateData) {
            throw new UnauthorizedException('Invalid or expired state parameter');
        }
        await this.redis.del(`oauth:shopify:${query.state}`);

        // Custom-app connects carry their own credentials in the state;
        // otherwise this is the platform public app (env credentials).
        const clientId = stateData.clientId ?? this.clientId;
        const clientSecret = stateData.clientSecret ?? this.clientSecret;
        const isCustomApp = !!stateData.clientId;

        // 2. Merchant hit "cancel" on the grant screen → redirect without a code
        if (!query.code) {
            throw new BadRequestException('Installation was cancelled');
        }

        // 3. Validate HMAC with the secret of whichever app is installing
        this.verifyHmacWithSecret(query as unknown as Record<string, string>, clientSecret);

        // 4. Shop param must be a valid myshopify domain AND the one we started with
        if (
            !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(query.shop) ||
            query.shop !== stateData.shopDomain
        ) {
            throw new BadRequestException('Shop domain mismatch');
        }

        // 5. Exchange code for an EXPIRING offline token — mandatory for public
        // apps created on/after 2026-04-01 (`expiring: '1'`). The response then
        // carries a 1-hour access token plus a 90-day rotating refresh token;
        // getAccessToken() below transparently refreshes on use.
        const tokenResponse = await fetch(
            `https://${query.shop}/admin/oauth/access_token`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    code: query.code,
                    expiring: '1',
                }),
                // Bound the exchange. Without a signal this is capped only by
                // undici's ~300s default, which would hold the OAuth callback
                // open long past any useful point.
                signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
            },
        );

        if (!tokenResponse.ok) {
            const error = await tokenResponse.text();
            this.logger.error(`Shopify token exchange failed: ${error}`);
            throw new BadRequestException('Failed to exchange authorization code');
        }

        const tokenData = (await tokenResponse.json()) as {
            access_token: string;
            scope: string;
            expires_in?: number;
            refresh_token?: string;
            refresh_token_expires_in?: number;
        };

        // 6. Get shop info — GraphQL only. REST `shop.json` returns 403 for
        // apps created after Shopify's REST Admin API sunset.
        let shopInfo: ShopInfoResponse['shop'];
        try {
            const res = await this.graphql.request<ShopInfoResponse>(
                { shopDomain: query.shop, accessToken: tokenData.access_token },
                SHOP_INFO_QUERY,
            );
            shopInfo = res.shop;
        } catch (error) {
            this.logger.error(
                `Shop info query failed after token exchange: ${error instanceof Error ? error.message : error}`,
                error instanceof ShopifyGraphqlError ? JSON.stringify(error.details) : undefined,
            );
            throw new BadRequestException('Could not fetch shop details');
        }
        const shopData = {
            shop: {
                id: ShopifyGraphqlClient.extractId(shopInfo.id),
                name: shopInfo.name,
                currency: shopInfo.currencyCode,
            },
        };

        // 7. Store credentials — accessToken (+ refresh token & expiries for
        // expiring tokens). Public-app installs carry no per-merchant
        // apiKey/apiSecret; webhooks are HMAC-verified with the app-level
        // client secret instead.
        const channelData = {
            name: shopData.shop.name || query.shop,
            status: ChannelStatus.CONNECTED,
            isEnabled: true,
            credentials: {
                accessToken: this.encryption.encrypt(tokenData.access_token),
                ...(tokenData.refresh_token
                    ? {
                        refreshToken: this.encryption.encrypt(tokenData.refresh_token),
                        accessTokenExpiresAt: new Date(
                            Date.now() + (tokenData.expires_in ?? 3600) * 1000,
                        ).toISOString(),
                        refreshTokenExpiresAt: new Date(
                            Date.now() + (tokenData.refresh_token_expires_in ?? 7776000) * 1000,
                        ).toISOString(),
                    }
                    : {}),
                // Custom-app connects persist their app identity so webhook
                // HMAC verification (per-channel fallback) and token refresh
                // use the right credentials for this channel.
                ...(isCustomApp
                    ? {
                        apiKey: this.encryption.encrypt(clientId),
                        apiSecret: this.encryption.encrypt(clientSecret),
                    }
                    : {}),
                shopDomain: query.shop,
                scopes: tokenData.scope,
            },
            externalStoreId: String(shopData.shop.id),
            externalStoreUrl: `https://${query.shop}`,
            syncStatus: SyncStatus.IDLE,
        };

        // 8. Create (or, on reconnect, update) the Channel + inherit the org
        // currency atomically. The Shopify shop is the source of truth for
        // the org's currency — merchants sell in whatever currency their
        // storefront is set to, so we inherit it here instead of asking
        // during onboarding. Only updates if Shopify returned a non-empty
        // currency; otherwise leaves the existing org currency alone.
        let channel;
        try {
            channel = await this.prisma.$transaction(async (tx) => {
                const ch = stateData.reconnectChannelId
                    ? await tx.channel.update({
                        where: { id: stateData.reconnectChannelId },
                        data: channelData,
                    })
                    : await tx.channel.create({
                        data: {
                            organizationId: stateData.orgId,
                            platform: ChannelPlatform.SHOPIFY,
                            ...channelData,
                        },
                    });
                if (shopData.shop.currency) {
                    await tx.organization.update({
                        where: { id: stateData.orgId },
                        data: { currency: shopData.shop.currency },
                    });
                }
                return ch;
            });
        } catch (error) {
            // Unique (platform, externalStoreId) — another org's channel row
            // still holds this store (e.g. a connect race, or a claim from
            // before disconnect released store ids).
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ConflictException(
                    'This Shopify store is already linked to another organization. Disconnect it there first.',
                );
            }
            throw error;
        }

        this.logger.log(
            `Shopify store connected (public app): ${query.shop} → org ${stateData.orgId} ` +
            `(currency: ${shopData.shop.currency ?? 'unchanged'}` +
            `${stateData.reconnectChannelId ? ', reconnect' : ''})`,
        );

        // Removed: automatic bulk-push of CRM-only products on Shopify connect.
        // Merchants now decide what crosses the line — they can push individual
        // items via the per-row Sync action, or run a one-click bulk push from
        // the Channels page Sync button (which now also pushes unsynced data).

        const frontendUrl = this.config.get<string>('frontendUrl');
        const redirectUrl = `${frontendUrl}/settings/channels?connected=shopify&channelId=${channel.id}`;

        return { channelId: channel.id, organizationId: stateData.orgId, redirectUrl };
    }

    /**
     * What a channel's stored grant is short of, if anything.
     *
     * Shopify pins a token to the scopes it was issued with, so widening the
     * requested list does nothing for stores already connected — they keep the
     * old grant until someone re-runs the install. Silently, until now: a store
     * that predates the draft-order/fulfilment scopes simply fails those calls,
     * and one without `read_all_orders` imports 60 days of history and reports
     * success. This is what lets the UI say "reconnect required" instead.
     */
    describeScopeStatus(credentials: unknown): ShopifyScopeStatus {
        const granted = (credentials as { scopes?: string } | null | undefined)?.scopes;
        const missing = missingScopes(this.scopes, granted);
        return { known: !!granted, missing, reconnectRequired: missing.length > 0 };
    }

    // ─── MANUAL CONNECT (legacy fallback) ───
    // For merchants who create a custom app in their Shopify Admin and provide
    // credentials. Kept as the de-emphasized "Advanced" path in the connect
    // dialog for stores that can't install the public app. Channels created
    // here carry a per-merchant apiSecret in credentials, which the webhook
    // controller still accepts as a legacy HMAC fallback.
    async manualConnect(orgId: string, shopDomain: string, apiKey: string, apiSecret: string, accessToken: string) {
        // An existing row is only a conflict when it is a DIFFERENT, live
        // store.
        //
        // Rejecting unconditionally created a dead end: webhook registration
        // used to run inside this request and could outlive the client's 30s
        // timeout, so the merchant saw a failure for a store that had
        // connected - and every retry then hit this exception, with
        // "Disconnect it first" as the only way out. Reconnecting the same
        // domain, or replacing a DISCONNECTED channel, updates the row in
        // place (which is also what the public-app Reconnect button does).
        const existing = await this.prisma.channel.findFirst({
            where: { organizationId: orgId, platform: ChannelPlatform.SHOPIFY },
        });
        const sameStore =
            existing?.externalStoreUrl === `https://${shopDomain}`;
        if (
            existing &&
            !sameStore &&
            existing.status !== ChannelStatus.DISCONNECTED
        ) {
            throw new ConflictException('A Shopify store is already connected. Disconnect it first.');
        }

        // Validate the token by fetching shop info via GraphQL (works for both
        // legacy custom-app tokens and new-app tokens; REST shop.json is 403
        // for recently-created apps).
        let shopData: { shop: { id: string; name: string; currency: string } };
        try {
            const res = await this.graphql.request<ShopInfoResponse>(
                { shopDomain, accessToken },
                SHOP_INFO_QUERY,
            );
            shopData = {
                shop: {
                    id: ShopifyGraphqlClient.extractId(res.shop.id),
                    name: res.shop.name,
                    currency: res.shop.currencyCode,
                },
            };
        } catch (error) {
            if (error instanceof ShopifyGraphqlError && error.code === 'AUTH_FAILED') {
                this.logger.error(`Shopify credential validation failed: ${error.message}`);
                throw new BadRequestException(
                    'Invalid credentials. Please check your store URL and access token.',
                );
            }
            this.logger.error('Failed to connect to Shopify', error);
            throw new BadRequestException(
                'Could not connect to Shopify. Please verify your store URL and credentials.',
            );
        }

        // Reject a store already claimed by ANOTHER organization.
        //
        // The database does enforce this via the unique index
        // (platform, external_store_id) — but only as an insert-time
        // constraint, so without this check the merchant sees a raw P2002
        // instead of an explanation. The URL arm matters independently: the
        // webhook router resolves tenants by external_store_url, and rows with
        // a NULL external_store_id sit outside that unique index entirely
        // (Postgres treats NULLs as distinct).
        //
        // The other organization is deliberately not named — that would leak
        // tenant information to anyone probing store domains.
        const claimedElsewhere = await this.prisma.channel.findFirst({
            where: {
                platform: ChannelPlatform.SHOPIFY,
                organizationId: { not: orgId },
                OR: [
                    { externalStoreId: String(shopData.shop.id) },
                    { externalStoreUrl: `https://${shopDomain}` },
                ],
            },
            select: { id: true },
        });
        if (claimedElsewhere) {
            throw new ConflictException(
                `The Shopify store ${shopDomain} is already connected to another workspace. ` +
                `Disconnect it there first, or contact support if you believe this is an error.`,
            );
        }

        // Encrypt sensitive credentials before storing
        const encryptedToken = this.encryption.encrypt(accessToken);
        const encryptedApiKey = this.encryption.encrypt(apiKey);
        const encryptedApiSecret = this.encryption.encrypt(apiSecret);

        // Create Channel + update Organization currency atomically.
        // Same rationale as the OAuth flow: the Shopify shop's currency is the
        // source of truth for the org's currency.
        const channelData = {
            name: shopData.shop.name || shopDomain,
            status: ChannelStatus.CONNECTED,
            isEnabled: true,
            credentials: {
                accessToken: encryptedToken,
                apiKey: encryptedApiKey,
                apiSecret: encryptedApiSecret,
                shopDomain,
                scopes: 'custom_app',
            },
            externalStoreId: String(shopData.shop.id),
            externalStoreUrl: `https://${shopDomain}`,
        };

        // Update-or-create by primary key rather than `upsert`. Prisma would
        // compile an upsert on the compound unique into
        // INSERT ... ON CONFLICT (organization_id, platform) - and that index,
        // though declared in schema.prisma, is NOT present in this database
        // (it was lost in the migration divergence), so Postgres would reject
        // the statement. The public-app path branches explicitly for the same
        // reason.
        const channel = await this.prisma.$transaction(async (tx) => {
            const ch = existing
                ? await tx.channel.update({
                    where: { id: existing.id },
                    // syncStatus / lastSyncedAt are deliberately left alone: a
                    // reconnect should resume where the sync got to rather
                    // than re-backfill from scratch.
                    data: channelData,
                })
                : await tx.channel.create({
                    data: {
                        organizationId: orgId,
                        platform: ChannelPlatform.SHOPIFY,
                        syncStatus: SyncStatus.IDLE,
                        ...channelData,
                    },
                });
            if (shopData.shop.currency) {
                await tx.organization.update({
                    where: { id: orgId },
                    data: { currency: shopData.shop.currency },
                });
            }
            return ch;
        });

        this.logger.log(
            `Shopify store connected (custom app): ${shopDomain} → org ${orgId} ` +
            `(currency: ${shopData.shop.currency ?? 'unchanged'})`,
        );

        // Removed: automatic bulk-push of CRM-only products on Shopify connect.
        // See note in the OAuth callback flow above — merchants now opt in.

        return {
            channelId: channel.id,
            shopName: shopData.shop.name,
            shopDomain,
        };
    }

    // Get decrypted access token for making API calls.
    //
    // Strict on platform — only SHOPIFY channels carry credentials. Calling this
    // on a MANUAL / INSTAGRAM / WHATSAPP channel is a caller bug (e.g. someone
    // enqueued a Shopify sync job for the wrong channel id); fail fast with a
    // clear message so the caller can be fixed, instead of silently flipping
    // unrelated channels to DISCONNECTED.
    async getAccessToken(channelId: string): Promise<{ token: string; shopDomain: string }> {
        const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
        if (!channel) {
            throw new BadRequestException(`Channel ${channelId} not found`);
        }
        if (channel.platform !== ChannelPlatform.SHOPIFY) {
            throw new BadRequestException(
                `Channel "${channel.name}" is on platform ${channel.platform}, not SHOPIFY. ` +
                `Shopify-only operations cannot run against it.`,
            );
        }
        if (!channel.credentials) {
            // Genuinely broken state for a Shopify channel — flip to DISCONNECTED
            // so the UI surfaces a "Reconnect" affordance instead of looping retries.
            if (channel.status !== ChannelStatus.DISCONNECTED) {
                await this.prisma.channel.update({
                    where: { id: channelId },
                    data: { status: ChannelStatus.DISCONNECTED },
                });
            }
            throw new BadRequestException(
                `Shopify channel "${channel.name}" has no stored credentials. ` +
                `Reconnect the store from Settings → Channels to restore sync.`,
            );
        }

        const creds = channel.credentials as {
            accessToken: string;
            shopDomain: string;
            refreshToken?: string;
            accessTokenExpiresAt?: string;
            refreshTokenExpiresAt?: string;
        };

        // Legacy custom-app channels carry a non-expiring token — no refresh.
        if (!creds.refreshToken || !creds.accessTokenExpiresAt) {
            return { token: this.encryption.decrypt(creds.accessToken), shopDomain: creds.shopDomain };
        }

        // Expiring offline token (public app, 1h TTL): return while it still
        // has >2 minutes of life, otherwise refresh before use.
        const expiresAt = new Date(creds.accessTokenExpiresAt).getTime();
        if (expiresAt - Date.now() > 2 * 60 * 1000) {
            return { token: this.encryption.decrypt(creds.accessToken), shopDomain: creds.shopDomain };
        }

        return this.refreshAccessToken(channelId);
    }

    /**
     * Refresh an expiring offline access token (1h TTL) using the stored
     * 90-day refresh token. Refresh tokens ROTATE — each refresh returns a new
     * one and consumes the old — so concurrent workers are serialised through
     * a short Redis lock; losers wait and re-read what the winner persisted.
     */
    private async refreshAccessToken(channelId: string): Promise<{ token: string; shopDomain: string }> {
        const lockKey = `oauth:shopify:refresh:${channelId}`;
        const gotLock = await this.redis.acquireLock(lockKey, 15);
        if (!gotLock) {
            await new Promise((r) => setTimeout(r, 2000));
            return this.getAccessToken(channelId);
        }

        try {
            // Re-read inside the lock — another worker may have already
            // refreshed while this one queued for the lock.
            const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
            const current = channel?.credentials as {
                accessToken: string;
                shopDomain: string;
                refreshToken?: string;
                accessTokenExpiresAt?: string;
                apiKey?: string;
                apiSecret?: string;
            } | null;
            if (!current?.refreshToken) {
                throw new BadRequestException(`Shopify channel ${channelId} has no refresh token`);
            }
            const expiresAt = current.accessTokenExpiresAt
                ? new Date(current.accessTokenExpiresAt).getTime()
                : 0;
            if (expiresAt - Date.now() > 2 * 60 * 1000) {
                return { token: this.encryption.decrypt(current.accessToken), shopDomain: current.shopDomain };
            }

            // Channels connected with a merchant-supplied custom app carry
            // their own app identity — refresh with it, not the env app.
            const clientId = current.apiKey ? this.encryption.decrypt(current.apiKey) : this.clientId;
            const clientSecret = current.apiSecret ? this.encryption.decrypt(current.apiSecret) : this.clientSecret;

            const res = await fetch(`https://${current.shopDomain}/admin/oauth/access_token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'refresh_token',
                    refresh_token: this.encryption.decrypt(current.refreshToken),
                }),
                // This call runs while holding a 15s Redis lock. Unbounded, a
                // silent socket would outlive the lock by minutes — it would
                // expire underneath us, other callers would assume no refresh
                // was in flight, and they would all start their own.
                signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
            });

            if (!res.ok) {
                const errorBody = await res.text();
                this.logger.error(
                    `Shopify token refresh failed for channel ${channelId}: ${res.status} ${errorBody}`,
                );
                // Refresh token expired (store idle >90 days) or revoked —
                // flip to DISCONNECTED so the UI surfaces "Reconnect".
                await this.prisma.channel.update({
                    where: { id: channelId },
                    data: { status: ChannelStatus.DISCONNECTED },
                });
                throw new UnauthorizedException(
                    'Shopify access expired. Reconnect the store from the Channels page.',
                );
            }

            const data = (await res.json()) as {
                access_token: string;
                expires_in?: number;
                refresh_token?: string;
                refresh_token_expires_in?: number;
            };

            const updatedCreds: Record<string, unknown> = {
                ...(channel!.credentials as Record<string, unknown>),
                accessToken: this.encryption.encrypt(data.access_token),
                accessTokenExpiresAt: new Date(
                    Date.now() + (data.expires_in ?? 3600) * 1000,
                ).toISOString(),
                ...(data.refresh_token
                    ? { refreshToken: this.encryption.encrypt(data.refresh_token) }
                    : {}),
                ...(data.refresh_token_expires_in
                    ? {
                        refreshTokenExpiresAt: new Date(
                            Date.now() + data.refresh_token_expires_in * 1000,
                        ).toISOString(),
                    }
                    : {}),
            };
            await this.prisma.channel.update({
                where: { id: channelId },
                data: { credentials: updatedCreds as any },
            });

            this.logger.log(`Refreshed Shopify access token for channel ${channelId}`);
            return { token: data.access_token, shopDomain: current.shopDomain };
        } finally {
            await this.redis.del(lockKey);
        }
    }

    // Verify Shopify OAuth-callback HMAC (hex, over sorted query params minus
    // `hmac`) using a specific secret
    private verifyHmacWithSecret(query: Record<string, string>, secret: string): void {
        const { hmac, ...params } = query;
        const sortedParams = Object.keys(params)
            .sort()
            .map((key) => `${key}=${params[key]}`)
            .join('&');

        const generatedHmac = createHmac('sha256', secret)
            .update(sortedParams)
            .digest('hex');

        const hmacBuffer = Buffer.from(hmac, 'hex');
        const generatedBuffer = Buffer.from(generatedHmac, 'hex');

        if (hmacBuffer.length !== generatedBuffer.length || !timingSafeEqual(hmacBuffer, generatedBuffer)) {
            throw new UnauthorizedException('Invalid HMAC signature');
        }
    }

    // ─── WEBHOOK MANAGEMENT ───

    private readonly WEBHOOK_TOPICS = [
        // Lifecycle: fired when the merchant removes the app — the access
        // token is revoked at that moment, so the webhook controller flips
        // the channel to DISCONNECTED and nulls its credentials.
        // (GDPR compliance topics are NOT registered here — they are
        // configured in the Partner Dashboard / shopify.app.toml only.)
        'app/uninstalled',
        'products/create',
        'products/update',
        'products/delete',
        'orders/create',
        'orders/updated',
        'orders/cancelled',
        'orders/fulfilled',
        'orders/partially_fulfilled',
        // A refund issued in Shopify admin fires this. Without it a standalone
        // refund reaches us only if Shopify happens to send `orders/updated`
        // too, so refund data arrived by luck rather than by subscription.
        'refunds/create',
        // NOTE: `fulfillments/create` and `fulfillments/update` are NOT
        // valid Shopify webhook topics — Shopify rejects them with
        // "Invalid topic specified". The fulfillment data is already
        // reconciled through `orders/fulfilled` and `orders/updated`
        // (both flow through `upsertOrder`, which reads the fulfillments
        // array off the parent order). If we ever need per-fulfillment
        // events, the correct family is `fulfillment_orders/*` — but the
        // webhook controller doesn't act on those today, so subscribing
        // would just create noise.
        'draft_orders/create',
        'draft_orders/update',
        'customers/create',
        'customers/update',
        'inventory_levels/update',
        // Analytics — populates `RawAnalyticsEvent` and feeds the hourly
        // aggregator that lights up the per-product add-to-cart and
        // per-product checkout panels on the analytics page.
        'carts/create',
        'carts/update',
        'checkouts/create',
        'checkouts/update',
        'checkouts/delete',
    ];

    /** REST topic string → WebhookSubscriptionTopic enum (products/create → PRODUCTS_CREATE). */
    private toWebhookTopicEnum(topic: string): string {
        return topic.toUpperCase().replace(/\//g, '_');
    }

    async registerWebhooks(channelId: string): Promise<void> {
        const { token, shopDomain } = await this.getAccessToken(channelId);
        const callbackUrl = `${this.appUrl}/api/v1/webhooks/shopify`;

        // Shopify only accepts public HTTPS URLs for webhook destinations.
        // Localhost / HTTP fails once per topic with the same error —
        // short-circuit and log one clear actionable line instead.
        if (!callbackUrl.startsWith('https://')) {
            this.logger.warn(
                `Skipping webhook registration for channel ${channelId}: APP_URL is not HTTPS (${this.appUrl}). ` +
                `Shopify requires public HTTPS webhook URLs. Use ngrok or a public tunnel for local dev, ` +
                `or set APP_URL to your production HTTPS URL.`,
            );
            return;
        }

        const auth = { shopDomain, accessToken: token };
        for (const topic of this.WEBHOOK_TOPICS) {
            try {
                const res = await this.graphql.request<
                    WebhookSubscriptionCreateResponse,
                    WebhookSubscriptionCreateVariables
                >(auth, WEBHOOK_SUBSCRIPTION_CREATE_MUTATION, {
                    topic: this.toWebhookTopicEnum(topic),
                    webhookSubscription: { callbackUrl, format: 'JSON' },
                });

                const userErrors = res.webhookSubscriptionCreate?.userErrors ?? [];
                if (userErrors.length > 0) {
                    // "Address for this topic has already been taken" = already
                    // registered — idempotent success, same as the old REST path.
                    const alreadyTaken = userErrors.every((e) =>
                        e.message.toLowerCase().includes('already been taken'),
                    );
                    if (alreadyTaken) {
                        this.logger.debug(`Webhook ${topic} already registered for ${shopDomain}`);
                    } else {
                        this.logger.warn(
                            `Failed to register webhook ${topic}: ${userErrors.map((e) => e.message).join('; ')}`,
                        );
                    }
                } else {
                    this.logger.log(`Registered webhook: ${topic} → ${callbackUrl}`);
                }
            } catch (error) {
                this.logger.error(`Error registering webhook ${topic}`, error);
            }
        }
    }

    async unregisterWebhooks(channelId: string): Promise<void> {
        try {
            const { token, shopDomain } = await this.getAccessToken(channelId);
            const auth = { shopDomain, accessToken: token };

            const list = await this.graphql.request<WebhookSubscriptionsListResponse>(
                auth,
                WEBHOOK_SUBSCRIPTIONS_QUERY,
                { first: 100 },
            );

            for (const webhook of list.webhookSubscriptions?.nodes ?? []) {
                try {
                    await this.graphql.request<WebhookSubscriptionDeleteResponse>(
                        auth,
                        WEBHOOK_SUBSCRIPTION_DELETE_MUTATION,
                        { id: webhook.id },
                    );
                    this.logger.log(`Unregistered webhook ${webhook.id} (${webhook.topic})`);
                } catch (error) {
                    this.logger.error(`Error unregistering webhook ${webhook.id}`, error);
                }
            }
        } catch (error) {
            this.logger.warn('Could not unregister webhooks (credentials may already be cleared)', error);
        }
    }

}