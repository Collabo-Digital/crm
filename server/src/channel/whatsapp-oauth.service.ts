import {
    Injectable,
    ConflictException,
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
    Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
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
import { PhoneNumberDetails, WhatsAppAccountService } from './whatsapp-account.service';
import { patchChannelMetadataSql } from './channel-metadata.util';
import {
    COEXISTENCE_SYNC_JOB_OPTS,
    CoexistenceSyncJobData,
    WHATSAPP_ONBOARDING_QUEUE,
    coexistenceSyncJobId,
} from './whatsapp-onboarding.queue';
import { TEMPLATE_PACK_QUEUE, TemplatePackJobData, startPackOnConnect } from '../campaigns/templates/pack/template-pack.queue';

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

/** What Embedded Signup posted to the page when the business finished. */
export interface WhatsAppSignupSession {
    phoneNumberId?: string;
    /** v4 `waba_id`, or the first of v5 `messaging_account_ids`. */
    wabaId?: string;
    /** v5: the business onboarded its WhatsApp Business app number (coexistence). */
    isOnBizApp?: boolean;
    businessId?: string;
}

const TAKEN_ELSEWHERE =
    'This WhatsApp Business account is already connected to another organization. Disconnect it there first.';

export interface WhatsAppSetupOutcome {
    webhooks: 'ok' | 'failed';
    webhooksError?: string;
    registration: 'ok' | 'failed' | 'not_needed';
    registrationError?: string;
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
        private readonly account: WhatsAppAccountService,
        @InjectQueue(WHATSAPP_ONBOARDING_QUEUE) private readonly onboardingQueue: Queue<CoexistenceSyncJobData>,
        @InjectQueue(TEMPLATE_PACK_QUEUE) private readonly packQueue: Queue<TemplatePackJobData>,
    ) {
        this.appId = this.config.get<string>('whatsapp.appId')!;
        this.appSecret = this.config.get<string>('whatsapp.appSecret')!;
        this.configId = this.config.get<string>('whatsapp.configId')!;
        this.graphVersion = this.config.get<string>('whatsapp.graphVersion')!;
        this.frontendUrl = this.config.get<string>('frontendUrl')!;
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

    /** Whether a channel of another organization holds this WABA. */
    private async heldByAnotherOrg(wabaId: string, orgId: string): Promise<boolean> {
        const holder = await this.prisma.channel.findFirst({
            where: { platform: ChannelPlatform.WHATSAPP, externalStoreId: wabaId, organizationId: { not: orgId } },
            select: { id: true },
        });
        return !!holder;
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

    // Step 2: Frontend calls this with the `code` Meta's popup returned, plus
    // the session info Embedded Signup posted to the page (which account and
    // number the business picked, and whether it is a WhatsApp Business app
    // number). The code lives for 30 seconds, so nothing slow runs before the
    // exchange.
    async handleSignupCallback(
        code: string,
        state: string,
        callerOrgId: string,
        callerUserId: string,
        session: WhatsAppSignupSession = {},
    ): Promise<{
        channelId: string;
        redirectUrl: string;
        account: ChannelAccountSummary | null;
        isOnBizApp: boolean;
        setup: WhatsAppSetupOutcome;
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
        // The channel is created in the state's org, so the state must have
        // been issued to this same caller in this same org.
        if (stateData.orgId !== callerOrgId || stateData.userId !== callerUserId) {
            throw new UnauthorizedException('Invalid or expired state parameter');
        }
        await this.redis.del(stateKey);

        // 2. Exchange the code. Embedded Signup issues a business integration
        // system user token, which does not expire; there is no long-lived
        // exchange to make, and `expires_in` is normally absent.
        const tokenRes = await this.graphGet<MetaTokenResponse>('/oauth/access_token', {
            client_id: this.appId,
            client_secret: this.appSecret,
            code,
        });
        if (!tokenRes.ok) {
            this.logger.error(`WhatsApp token exchange failed: ${tokenRes.error}`);
            throw new BadRequestException(
                'Meta did not accept the signup code. It expires after 30 seconds — please try connecting again.',
            );
        }
        const token = tokenRes.data.access_token;
        const tokenExpiresAt = tokenRes.data.expires_in
            ? new Date(Date.now() + tokenRes.data.expires_in * 1000)
            : null;

        // 3. Which account. Session info names it (v4 `waba_id`, v5
        // `messaging_account_ids`); older flows only reveal it in the token.
        let wabaId = session.wabaId;
        if (!wabaId) {
            const debugRes = await this.graphGet<MetaDebugTokenResponse>(
                '/debug_token',
                { input_token: token },
                `${this.appId}|${this.appSecret}`,
            );
            if (!debugRes.ok) {
                this.logger.error(`WhatsApp debug_token failed: ${debugRes.error}`);
                throw new BadRequestException('Failed to inspect access token');
            }
            wabaId = this.extractWabaId(debugRes.data);
        }
        if (!wabaId) {
            throw new BadRequestException(
                'No WhatsApp Business Account granted. Please retry and select a WABA in the popup.',
            );
        }

        // 4. Which number, and what it is.
        const phoneNumberId = session.phoneNumberId ?? (await this.account.firstNumberId(wabaId, token));
        if (!phoneNumberId) {
            throw new BadRequestException(
                'No phone number found on this WhatsApp Business Account. Please add one in WhatsApp Manager first.',
            );
        }
        let number: PhoneNumberDetails;
        try {
            number = await this.account.fetchNumber(wabaId, phoneNumberId, token);
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            this.logger.error(`WhatsApp number ${phoneNumberId} read failed: ${err instanceof Error ? err.message : err}`);
            throw new BadRequestException('Failed to read the WhatsApp phone number from Meta');
        }
        const isOnBizApp = session.isOnBizApp ?? number.is_on_biz_app === true;

        // 5. Display metadata for the account (name, owning business). Optional.
        let wabaName: string | undefined;
        let businessId: string | undefined = session.businessId;
        const wabaRes = await this.graphGet<{
            id: string;
            name?: string;
            owner_business_info?: { id?: string; name?: string };
        }>(`/${wabaId}`, { fields: 'id,name,owner_business_info' }, token);
        if (wabaRes.ok) {
            wabaName = wabaRes.data.name;
            businessId = businessId ?? wabaRes.data.owner_business_info?.id;
        } else {
            this.logger.warn(`Non-fatal: could not fetch WABA metadata for ${wabaId}`);
        }

        // 6. Persist the Channel row.
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
        // Webhooks are routed by WABA id alone, so it may belong to one
        // organization only. Checked here rather than left to the unique
        // index, which a database with older duplicates does not have.
        if (await this.heldByAnotherOrg(wabaId, stateData.orgId)) {
            throw new ConflictException(TAKEN_ELSEWHERE);
        }

        // Reconnect UPDATES an existing row, so merge into its metadata rather
        // than replacing it — the same rule ChannelService.disconnect follows.
        const existing = decision.kind === 'reconnect' ? rows.find((r) => r.id === decision.channelId) : undefined;
        const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
        // A reconnected number keeps the PIN it was registered with; a new
        // one would fail re-registration against the PIN already set.
        const existingPin = await this.existingPin(decision.kind === 'reconnect' ? decision.channelId : undefined);
        const pin = isOnBizApp ? null : existingPin ?? WhatsAppAccountService.newPin();

        const connectedAt = new Date();
        const credentials = {
            wabaId,
            wabaName,
            businessId,
            phoneNumberId,
            displayPhoneNumber: number.display_phone_number,
            verifiedName: number.verified_name,
            codeVerificationStatus: number.code_verification_status,
            qualityRating: number.quality_rating,
            platformType: number.platform_type,
            isOnBizApp,
            accessToken: this.encryption.encrypt(token),
            registrationPin: pin ? this.encryption.encrypt(pin) : null,
            // Kept as a key even when null, so the shape stays stable for
            // readTokenExpiry and for the migration's backfill of connected_at.
            tokenExpiresAt: tokenExpiresAt ? tokenExpiresAt.toISOString() : null,
            tokenType: 'business_integration_system_user',
            scopes: 'whatsapp_business_management,whatsapp_business_messaging',
            connectedAt: connectedAt.toISOString(),
        };
        const account = describeAccount(ChannelPlatform.WHATSAPP, credentials, null);

        const data = {
            name: number.verified_name || number.display_phone_number || wabaName || 'WhatsApp',
            status: ChannelStatus.CONNECTED,
            isEnabled: true,
            credentials: credentials as unknown as Prisma.InputJsonValue,
            externalStoreId: wabaId,
            connectedAt,
            lastError: null,
            syncStatus: SyncStatus.IDLE,
            metadata: {
                ...existingMeta,
                externalAccountId: wabaId,
                lastAccount: account,
                // Live again — a stale disconnect date would have the UI label
                // a connected account "Disconnected <date>".
                disconnectedAt: null,
                health: { number: { ...number, checkedAt: connectedAt.toISOString() } },
                coexistence: isOnBizApp ? { state: 'connected', reason: null, sendsPaused: false } : null,
                historySync: isOnBizApp ? { status: 'pending', onboardedAt: connectedAt.toISOString() } : null,
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
                throw new ConflictException(TAKEN_ELSEWHERE);
            }
            throw error;
        }

        // Collabo's recommended templates, created in the background on this
        // account. Not awaited, and never failing the connect. A reconnected
        // row is an account that existed before: its automations wait for the
        // merchant.
        const newChannel = decision.kind !== 'reconnect';
        void startPackOnConnect(this.prisma, this.packQueue, { organizationId: stateData.orgId, channelId: channel.id, wabaId, newChannel }).catch((err) =>
            this.logger.error(`Could not start the recommended templates on WABA ${wabaId}: ${err instanceof Error ? err.message : err}`),
        );

        // 7. Subscribe, register, start the coexistence sync. Each outcome is
        // recorded on the row; a failure leaves a connected channel with a
        // Retry setup action instead of a lost signup.
        const setup = await this.completeSetup(channel.id, { wabaId, phoneNumberId, token, pin, isOnBizApp });

        this.logger.log(
            `WhatsApp ${decision.kind === 'reconnect' ? 'reconnected' : 'connected'}: ` +
            `WABA ${wabaId} (${number.verified_name || number.display_phone_number}${isOnBizApp ? ', Business app number' : ''}) → org ${stateData.orgId}`,
        );

        const redirectUrl = `${this.frontendUrl}/settings/channels?connected=whatsapp&channelId=${channel.id}`;

        return { channelId: channel.id, redirectUrl, account, isOnBizApp, setup };
    }

    /**
     * Re-run the post-connect steps for a channel whose setup partly failed:
     * subscribe the app, register a Cloud API number, re-read its health.
     */
    async retrySetup(channelId: string, orgId: string): Promise<WhatsAppSetupOutcome> {
        const row = await this.prisma.channel.findFirst({
            where: { id: channelId, organizationId: orgId, platform: ChannelPlatform.WHATSAPP },
            select: { id: true },
        });
        if (!row) throw new NotFoundException('WhatsApp channel not found');
        const { creds, token } = await this.account.load(channelId);
        let pin: string | null = null;
        if (!creds.isOnBizApp) {
            pin = await this.existingPin(channelId);
            if (!pin) {
                pin = WhatsAppAccountService.newPin();
                // Stored before registering, so the PIN the number ends up
                // with is never lost to a crash between the two.
                await this.prisma.channel.update({
                    where: { id: channelId },
                    data: {
                        credentials: { ...creds, registrationPin: this.encryption.encrypt(pin) } as unknown as Prisma.InputJsonValue,
                    },
                });
            }
        }
        const outcome = await this.completeSetup(channelId, {
            wabaId: creds.wabaId,
            phoneNumberId: creds.phoneNumberId,
            token,
            pin,
            isOnBizApp: creds.isOnBizApp === true,
        });
        await this.account.refreshHealth(channelId).catch((err) => {
            if (isRateLimitedError(err)) throw err;
        });
        return outcome;
    }

    private async completeSetup(
        channelId: string,
        args: { wabaId: string; phoneNumberId: string; token: string; pin: string | null; isOnBizApp: boolean },
    ): Promise<WhatsAppSetupOutcome> {
        const at = new Date().toISOString();
        const outcome: WhatsAppSetupOutcome = { webhooks: 'ok', registration: args.isOnBizApp ? 'not_needed' : 'ok' };
        const problems: string[] = [];

        try {
            await this.account.subscribeApp(args.wabaId, args.token);
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            outcome.webhooks = 'failed';
            outcome.webhooksError = err instanceof Error ? err.message : String(err);
            problems.push('Collabo could not subscribe to this number’s messages');
        }

        if (!args.isOnBizApp && args.pin) {
            try {
                await this.account.registerNumber(args.wabaId, args.phoneNumberId, args.token, args.pin);
            } catch (err) {
                if (isRateLimitedError(err)) throw err;
                outcome.registration = 'failed';
                outcome.registrationError = err instanceof Error ? err.message : String(err);
                problems.push('the number could not be registered for the Cloud API');
            }
        }

        await this.prisma.$executeRaw(
            patchChannelMetadataSql(channelId, 'setup', { ...outcome, checkedAt: at }),
        );
        await this.prisma.channel.update({
            where: { id: channelId },
            data: {
                lastError: problems.length
                    ? `Setup is incomplete: ${problems.join(', and ')}. Use Retry setup on this channel.`
                    : null,
            },
        });

        if (args.isOnBizApp) {
            await this.onboardingQueue
                .add(
                    'coexistence-sync',
                    { channelId },
                    { ...COEXISTENCE_SYNC_JOB_OPTS, jobId: coexistenceSyncJobId(channelId) },
                )
                .catch((err) => this.logger.error(`Could not queue coexistence sync for ${channelId}: ${err}`));
        }
        return outcome;
    }

    private async existingPin(channelId: string | undefined): Promise<string | null> {
        if (!channelId) return null;
        const row = await this.prisma.channel.findUnique({ where: { id: channelId }, select: { credentials: true } });
        const cipher = (row?.credentials as Record<string, unknown> | null)?.registrationPin;
        if (typeof cipher !== 'string' || !cipher) return null;
        try {
            return this.encryption.decrypt(cipher) || null;
        } catch {
            return null;
        }
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
