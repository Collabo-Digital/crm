import {
    Injectable,
    ConflictException,
    BadRequestException,
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
import { MetaGraphError } from './meta-graph.types';
import { Priority, isRateLimitedError } from '../rate-limit/rate-limit.types';
import {
    assertCanConnect,
    resolveConnectTarget,
    describeAccount,
    type ChannelAccountSummary,
} from './channel-connection.util';

interface MetaTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

interface MetaDebugTokenResponse {
    data: {
        app_id: string;
        user_id: string;
        is_valid: boolean;
        granular_scopes?: Array<{
            scope: string;
            target_ids?: string[];
        }>;
    };
}

interface WabaPhoneNumber {
    id: string;
    display_phone_number: string;
    verified_name: string;
    code_verification_status?: string;
    quality_rating?: string;
}

@Injectable()
export class WhatsAppOAuthService {
    private readonly logger = new Logger(WhatsAppOAuthService.name);
    private readonly appId: string;
    private readonly appSecret: string;
    private readonly configId: string;
    private readonly graphVersion: string;
    private readonly frontendUrl: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        private readonly encryption: EncryptionService,
        private readonly redis: RedisService,
        private readonly metaGraph: MetaGraphClient,
    ) {
        this.appId = this.config.get<string>('whatsapp.appId')!;
        this.appSecret = this.config.get<string>('whatsapp.appSecret')!;
        this.configId = this.config.get<string>('whatsapp.configId')!;
        this.graphVersion = this.config.get<string>('whatsapp.graphVersion')!;
        this.frontendUrl = this.config.get<string>('frontendUrl')!;
    }

    private graphUrl(path: string): string {
        return `https://graph.facebook.com/${this.graphVersion}${path}`;
    }

    /**
     * GET through the shared, rate-limited Meta client. Returns the same
     * ok/not-ok shape the connect flow branches on, so each step keeps its own
     * merchant-facing error; a rate limit propagates as `RateLimitedError`.
     */
    private async graphGet<T>(
        path: string,
        query: Record<string, string | undefined>,
        accessToken?: string,
    ): Promise<{ ok: true; data: T } | { ok: false; status?: number; error: string }> {
        try {
            const res = await this.metaGraph.request<T>({
                method: 'GET',
                path,
                query,
                accessToken,
                scopes: this.metaGraph.baseScopes(),
                priority: Priority.INTERACTIVE,
                graphVersion: this.graphVersion,
            });
            return { ok: true, data: res.data };
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            return {
                ok: false,
                status: err instanceof MetaGraphError ? err.httpStatus : undefined,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /** The org's WhatsApp rows, in the shape the decision helpers want. */
    private async whatsappRows(orgId: string) {
        return this.prisma.channel.findMany({
            where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP },
            select: {
                id: true,
                platform: true,
                status: true,
                externalStoreId: true,
                metadata: true,
            },
        });
    }

    // Step 1: Hand the frontend the configId + a CSRF state to feed into FB.login
    //
    // One ACTIVE WhatsApp account per org. The check used to reject on ANY
    // existing row, which meant an org that had ever disconnected WhatsApp could
    // never connect it again — the row is kept as history for its message logs.
    async getSignupConfig(
        orgId: string,
        userId: string,
        reconnectChannelId?: string,
    ): Promise<{ configId: string; state: string }> {
        if (!this.configId) {
            throw new BadRequestException(
                'WhatsApp integration is not configured on the server. Missing WHATSAPP_CONFIG_ID.',
            );
        }

        const rows = await this.whatsappRows(orgId);
        const decision = assertCanConnect(rows, ChannelPlatform.WHATSAPP, reconnectChannelId);
        if (decision.kind === 'blocked') {
            throw new ConflictException(decision.message);
        }

        const state = randomBytes(16).toString('hex');
        await this.redis.set(
            `${REDIS_KEYS.OAUTH_WHATSAPP}${state}`,
            { userId, orgId, reconnectChannelId },
            REDIS_TTL.OAUTH_STATE,
        );

        return { configId: this.configId, state };
    }

    // Step 2: Frontend calls this with the `code` Meta's popup returned.
    async handleSignupCallback(
        code: string,
        state: string,
    ): Promise<{
        channelId: string;
        redirectUrl: string;
        account: ChannelAccountSummary | null;
    }> {
        // 1. Validate CSRF state
        const stateKey = `${REDIS_KEYS.OAUTH_WHATSAPP}${state}`;
        const stateData = await this.redis.get<{
            userId: string;
            orgId: string;
            reconnectChannelId?: string;
        }>(stateKey);
        if (!stateData) {
            throw new UnauthorizedException('Invalid or expired state parameter');
        }
        await this.redis.del(stateKey);

        // 2. Exchange the short-lived code for an access token.
        const tokenRes = await this.graphGet<MetaTokenResponse>('/oauth/access_token', {
            client_id: this.appId,
            client_secret: this.appSecret,
            code,
        });
        if (!tokenRes.ok) {
            this.logger.error(`WhatsApp token exchange failed: ${tokenRes.error}`);
            throw new BadRequestException('Failed to exchange authorization code');
        }
        const tokenData = tokenRes.data;

        // 3. Upgrade to a long-lived token (~60 days).
        const longLivedRes = await this.graphGet<MetaTokenResponse>('/oauth/access_token', {
            grant_type: 'fb_exchange_token',
            client_id: this.appId,
            client_secret: this.appSecret,
            fb_exchange_token: tokenData.access_token,
        });
        if (!longLivedRes.ok) {
            this.logger.error(`WhatsApp long-lived token exchange failed: ${longLivedRes.error}`);
            throw new BadRequestException('Failed to get long-lived token');
        }
        const longLivedData = longLivedRes.data;
        const longLivedToken = longLivedData.access_token;
        // Null, NOT a fabricated 60 days: Embedded Signup issues a
        // business-integration system-user token, which does not expire and so
        // reports no `expires_in`. Inventing a date here made the channels page
        // brand a perfectly healthy connection "Expired" two months in.
        const tokenExpiresAt = longLivedData.expires_in
            ? new Date(Date.now() + longLivedData.expires_in * 1000)
            : null;

        // 4. Inspect the token to find which WABA(s) the merchant authorized.
        const debugRes = await this.graphGet<MetaDebugTokenResponse>(
            '/debug_token',
            { input_token: longLivedToken },
            `${this.appId}|${this.appSecret}`,
        );
        if (!debugRes.ok) {
            this.logger.error(`WhatsApp debug_token failed: ${debugRes.error}`);
            throw new BadRequestException('Failed to inspect access token');
        }
        const debugData = debugRes.data;

        const wabaId = this.extractWabaId(debugData);
        if (!wabaId) {
            throw new BadRequestException(
                'No WhatsApp Business Account granted. Please retry and select a WABA in the popup.',
            );
        }

        // 5. Fetch display metadata for the WABA (name, business owner).
        let wabaName: string | undefined;
        let businessId: string | undefined;
        try {
            const wabaRes = await this.graphGet<{
                id: string;
                name?: string;
                owner_business_info?: { id?: string; name?: string };
            }>(`/${wabaId}`, { fields: 'id,name,owner_business_info' }, longLivedToken);
            if (wabaRes.ok) {
                wabaName = wabaRes.data.name;
                businessId = wabaRes.data.owner_business_info?.id;
            }
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            this.logger.warn(`Non-fatal: could not fetch WABA metadata for ${wabaId}`);
        }

        // 6. Fetch the phone number(s) registered on this WABA — take the first.
        const phonesRes = await this.graphGet<{ data?: WabaPhoneNumber[] }>(
            `/${wabaId}/phone_numbers`,
            {},
            longLivedToken,
        );
        if (!phonesRes.ok) {
            this.logger.error(`WhatsApp phone_numbers fetch failed: ${phonesRes.error}`);
            throw new BadRequestException('Failed to fetch phone numbers for the WABA');
        }
        const phonesData = phonesRes.data;
        const phoneNumber = phonesData.data?.[0];
        if (!phoneNumber) {
            throw new BadRequestException(
                'No phone number found on this WhatsApp Business Account. Please add one in WhatsApp Manager first.',
            );
        }

        // 7. Persist the Channel row with encrypted token.
        //
        // Decided again here, not before the popup: the merchant spent the
        // intervening seconds inside Meta and may have picked a WABA that
        // another admin connected meanwhile.
        const rows = await this.whatsappRows(stateData.orgId);
        const decision = resolveConnectTarget(
            rows,
            ChannelPlatform.WHATSAPP,
            wabaId,
            stateData.reconnectChannelId,
        );
        if (decision.kind === 'blocked') {
            throw new ConflictException(decision.message);
        }

        // Reconnect UPDATES an existing row, so merge into its metadata rather
        // than replacing it — the same rule ChannelService.disconnect follows.
        const existingMeta =
            decision.kind === 'reconnect'
                ? ((rows.find((r) => r.id === decision.channelId)?.metadata ??
                    {}) as Record<string, unknown>)
                : {};

        const credentials = {
            wabaId,
            wabaName,
            businessId,
            phoneNumberId: phoneNumber.id,
            displayPhoneNumber: phoneNumber.display_phone_number,
            verifiedName: phoneNumber.verified_name,
            codeVerificationStatus: phoneNumber.code_verification_status,
            qualityRating: phoneNumber.quality_rating,
            accessToken: this.encryption.encrypt(longLivedToken),
            // Kept as a key even when null, so the shape stays stable for
            // readTokenExpiry and for the migration's backfill of connected_at.
            tokenExpiresAt: tokenExpiresAt ? tokenExpiresAt.toISOString() : null,
            scopes: 'whatsapp_business_management,whatsapp_business_messaging',
            connectedAt: new Date().toISOString(),
        };
        const account = describeAccount(ChannelPlatform.WHATSAPP, credentials, null);

        const data = {
            name:
                phoneNumber.verified_name ||
                phoneNumber.display_phone_number ||
                wabaName ||
                'WhatsApp',
            status: ChannelStatus.CONNECTED,
            isEnabled: true,
            credentials: credentials as unknown as Prisma.InputJsonValue,
            externalStoreId: wabaId,
            connectedAt: new Date(),
            lastError: null,
            syncStatus: SyncStatus.IDLE,
            metadata: {
                ...existingMeta,
                externalAccountId: wabaId,
                lastAccount: account,
                // Live again — a stale disconnect date would have the UI label
                // a connected account "Disconnected <date>".
                disconnectedAt: null,
            } as unknown as Prisma.InputJsonValue,
        };

        let channel: { id: string };
        try {
            channel =
                decision.kind === 'reconnect'
                    ? await this.prisma.channel.update({
                        where: { id: decision.channelId },
                        data,
                    })
                    : await this.prisma.channel.create({
                        data: {
                            ...data,
                            organizationId: stateData.orgId,
                            platform: ChannelPlatform.WHATSAPP,
                        },
                    });
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                // (platform, external_store_id) is unique table-wide, so this
                // WABA belongs to another organization. The per-org partial
                // unique should already have been caught by resolveConnectTarget.
                throw new ConflictException(
                    'This WhatsApp Business account is already connected to another organization. Disconnect it there first.',
                );
            }
            throw error;
        }

        this.logger.log(
            `WhatsApp ${decision.kind === 'reconnect' ? 'reconnected' : 'connected'}: ` +
            `WABA ${wabaId} (${phoneNumber.verified_name || phoneNumber.display_phone_number}) → org ${stateData.orgId}`,
        );

        const redirectUrl = `${this.frontendUrl}/settings/channels?connected=whatsapp&channelId=${channel.id}`;

        return { channelId: channel.id, redirectUrl, account };
    }

    // Pull the first WABA ID out of debug_token's granular_scopes.
    private extractWabaId(debug: MetaDebugTokenResponse): string | undefined {
        const scopes = debug.data.granular_scopes ?? [];
        const wabaScope = scopes.find((s) =>
            ['whatsapp_business_management', 'whatsapp_business_messaging'].includes(s.scope),
        );
        return wabaScope?.target_ids?.[0];
    }
}
