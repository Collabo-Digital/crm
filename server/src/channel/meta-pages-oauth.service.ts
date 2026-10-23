import {
    BadRequestException,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, ChannelStatus, Prisma, SyncStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS, REDIS_TTL } from '../redis/redis.constants';
import { EncryptionService } from './encryption.service';
import { MetaGraphClient } from './meta-graph.client';
import { metaScope } from './meta-graph.types';
import { Priority, isRateLimitedError } from '../rate-limit/rate-limit.types';
import { describeAccount, resolveConnectTarget, type ChannelAccountSummary } from './channel-connection.util';

/** Instagram rows connected through a Facebook Page rather than Instagram Login. */
export const FACEBOOK_LOGIN_FLOW = 'facebook_login';

/// Page webhook fields. One Page subscription carries Messenger AND the
/// Instagram messaging of the account linked to the Page.
export const PAGE_SUBSCRIBED_FIELDS = [
    'messages',
    'messaging_postbacks',
    'message_echoes',
    'message_deliveries',
    'message_reads',
    'message_reactions',
    'message_edits',
    'messaging_referrals',
    'messaging_handovers',
    'standby',
    'feed',
].join(',');

interface MetaPage {
    id: string;
    name?: string;
    access_token?: string;
    tasks?: string[];
    picture?: { data?: { url?: string } };
    instagram_business_account?: {
        id: string;
        username?: string;
        name?: string;
        profile_picture_url?: string;
    };
}

export interface PagesConnectResult {
    connected: Array<{ channelId: string; platform: ChannelPlatform; account: ChannelAccountSummary | null; webhooks: 'ok' | 'failed' }>;
    skipped: Array<{ name: string; reason: string }>;
}

/**
 * Facebook Pages (Messenger) and the Instagram professional accounts linked
 * to them, connected in one Facebook Login for Business popup.
 *
 * Meta lets an app use either Facebook Login or Instagram Login for
 * Instagram, not both, and Messenger needs Facebook Login — so Instagram rides
 * the Page here. Page tokens obtained this way do not expire.
 */
@Injectable()
export class MetaPagesOAuthService {
    private readonly logger = new Logger(MetaPagesOAuthService.name);
    private readonly appId: string;
    private readonly appSecret: string;
    private readonly configId: string | undefined;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        private readonly encryption: EncryptionService,
        private readonly redis: RedisService,
        private readonly metaGraph: MetaGraphClient,
    ) {
        this.appId = this.config.get<string>('meta.appId') ?? '';
        this.appSecret = this.config.get<string>('meta.appSecret') ?? '';
        this.configId = this.config.get<string>('messenger.configId');
    }

    async getConnectConfig(orgId: string, userId: string): Promise<{ configId: string; state: string }> {
        if (!this.configId) {
            throw new BadRequestException(
                'Messenger is not configured on the server. Missing MESSENGER_CONFIG_ID.',
            );
        }
        const state = randomBytes(16).toString('hex');
        await this.redis.set(`${REDIS_KEYS.OAUTH_META_PAGES}${state}`, { userId, orgId }, REDIS_TTL.OAUTH_STATE);
        return { configId: this.configId, state };
    }

    async handleCallback(code: string, state: string, callerOrgId: string, callerUserId: string): Promise<PagesConnectResult> {
        const stateKey = `${REDIS_KEYS.OAUTH_META_PAGES}${state}`;
        const stateData = await this.redis.get<{ userId: string; orgId: string }>(stateKey);
        if (!stateData || stateData.orgId !== callerOrgId || stateData.userId !== callerUserId) {
            throw new UnauthorizedException('Invalid or expired state parameter');
        }
        await this.redis.del(stateKey);

        const token = await this.exchange(code);
        const pages = await this.listPages(token);
        if (pages.length === 0) {
            throw new BadRequestException(
                'No Facebook Page was shared. Connect again and select at least one Page in the Meta popup.',
            );
        }

        const result: PagesConnectResult = { connected: [], skipped: [] };
        for (const page of pages) {
            if (!page.access_token) {
                result.skipped.push({ name: page.name ?? page.id, reason: 'Meta returned no Page token. You need full control of the Page.' });
                continue;
            }
            const webhooks = await this.subscribePage(page.id, page.access_token);
            const fb = await this.upsertChannel(stateData.orgId, ChannelPlatform.FACEBOOK, page.id, {
                authFlow: FACEBOOK_LOGIN_FLOW,
                pageId: page.id,
                pageName: page.name,
                pictureUrl: page.picture?.data?.url,
                tasks: page.tasks ?? [],
                pageAccessToken: this.encryption.encrypt(page.access_token),
                connectedAt: new Date().toISOString(),
            }, page.name ?? 'Facebook Page', webhooks);
            if ('skipped' in fb) result.skipped.push({ name: page.name ?? page.id, reason: fb.skipped });
            else result.connected.push({ ...fb, webhooks: webhooks.ok ? 'ok' : 'failed' });

            const ig = page.instagram_business_account;
            if (ig) {
                const igRow = await this.upsertChannel(stateData.orgId, ChannelPlatform.INSTAGRAM, ig.id, {
                    authFlow: FACEBOOK_LOGIN_FLOW,
                    instagramUserId: ig.id,
                    instagramUsername: ig.username,
                    name: ig.name,
                    profilePictureUrl: ig.profile_picture_url,
                    pageId: page.id,
                    pageName: page.name,
                    pageAccessToken: this.encryption.encrypt(page.access_token),
                    connectedAt: new Date().toISOString(),
                }, ig.username ? `@${ig.username}` : 'Instagram', webhooks);
                if ('skipped' in igRow) result.skipped.push({ name: ig.username ?? ig.id, reason: igRow.skipped });
                else result.connected.push({ ...igRow, webhooks: webhooks.ok ? 'ok' : 'failed' });
            }
        }

        this.logger.log(
            `Meta Pages connected for org ${stateData.orgId}: ${result.connected.length} channels, ${result.skipped.length} skipped`,
        );
        return result;
    }

    /** Stop a Page sending us webhooks. Best-effort, like every disconnect cleanup. */
    async unsubscribePage(pageId: string, encryptedToken: unknown): Promise<void> {
        if (typeof encryptedToken !== 'string') return;
        const token = this.encryption.decrypt(encryptedToken);
        if (!token) return;
        await this.metaGraph.request({
            method: 'DELETE',
            path: `/${pageId}/subscribed_apps`,
            accessToken: token,
            scopes: [...this.metaGraph.baseScopes(), metaScope.page(pageId)],
            pageId,
            priority: Priority.INTERACTIVE,
        });
    }

    /**
     * The code becomes a business integration system user token when the
     * configuration issues one (no expiry), or a short-lived user token, which
     * is swapped for a long-lived one so the Page tokens derived from it never
     * expire.
     */
    private async exchange(code: string): Promise<string> {
        const first = await this.graph<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
            client_id: this.appId,
            client_secret: this.appSecret,
            code,
        });
        if (!first.expires_in) return first.access_token;
        const longLived = await this.graph<{ access_token: string }>('/oauth/access_token', {
            grant_type: 'fb_exchange_token',
            client_id: this.appId,
            client_secret: this.appSecret,
            fb_exchange_token: first.access_token,
        });
        return longLived.access_token;
    }

    private async listPages(token: string): Promise<MetaPage[]> {
        const res = await this.graph<{ data?: MetaPage[] }>(
            '/me/accounts',
            {
                fields: 'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
                limit: '100',
            },
            token,
        );
        return res.data ?? [];
    }

    private async subscribePage(pageId: string, pageToken: string): Promise<{ ok: boolean; error?: string }> {
        try {
            await this.metaGraph.request({
                method: 'POST',
                path: `/${pageId}/subscribed_apps`,
                query: { subscribed_fields: PAGE_SUBSCRIBED_FIELDS },
                accessToken: pageToken,
                scopes: [...this.metaGraph.baseScopes(), metaScope.page(pageId)],
                pageId,
                priority: Priority.INTERACTIVE,
            });
            return { ok: true };
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            const error = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Page ${pageId} webhook subscription failed: ${error}`);
            return { ok: false, error };
        }
    }

    private async upsertChannel(
        orgId: string,
        platform: ChannelPlatform,
        externalId: string,
        credentials: Record<string, unknown>,
        name: string,
        webhooks: { ok: boolean; error?: string },
    ): Promise<{ channelId: string; platform: ChannelPlatform; account: ChannelAccountSummary | null } | { skipped: string }> {
        const rows = await this.prisma.channel.findMany({
            where: { organizationId: orgId, platform },
            select: { id: true, platform: true, status: true, externalStoreId: true, metadata: true },
        });
        const decision = resolveConnectTarget(rows, platform, externalId);
        if (decision.kind === 'blocked') return { skipped: decision.message };

        const existingMeta =
            decision.kind === 'reconnect'
                ? ((rows.find((r) => r.id === decision.channelId)?.metadata ?? {}) as Record<string, unknown>)
                : {};
        const account = describeAccount(platform, credentials, null);
        const data = {
            name,
            status: ChannelStatus.CONNECTED,
            isEnabled: true,
            credentials: credentials as Prisma.InputJsonValue,
            externalStoreId: externalId,
            connectedAt: new Date(),
            lastError: webhooks.ok
                ? null
                : 'Collabo could not subscribe to this Page’s messages. Reconnect, and make sure you have full control of the Page.',
            syncStatus: SyncStatus.IDLE,
            metadata: {
                ...existingMeta,
                externalAccountId: externalId,
                lastAccount: account,
                disconnectedAt: null,
                webhookSubscription: { ok: webhooks.ok, error: webhooks.error ?? null, at: new Date().toISOString() },
            } as Prisma.InputJsonValue,
        };
        try {
            const row =
                decision.kind === 'reconnect'
                    ? await this.prisma.channel.update({ where: { id: decision.channelId }, data })
                    : await this.prisma.channel.create({ data: { ...data, organizationId: orgId, platform } });
            return { channelId: row.id, platform, account };
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                return { skipped: 'Already connected to another organization. Disconnect it there first.' };
            }
            throw error;
        }
    }

    private async graph<T>(path: string, query: Record<string, string>, accessToken?: string): Promise<T> {
        try {
            const res = await this.metaGraph.request<T>({
                method: 'GET',
                path,
                query,
                accessToken,
                scopes: this.metaGraph.baseScopes(),
                priority: Priority.INTERACTIVE,
            });
            return res.data;
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            this.logger.error(`Meta ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
            throw new BadRequestException('Meta refused the Facebook connection. Please try again.');
        }
    }
}

