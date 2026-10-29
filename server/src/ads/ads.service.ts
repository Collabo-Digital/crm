import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { REDIS_KEYS, REDIS_TTL } from '../redis/redis.constants';
import { EncryptionService } from '../channel/encryption.service';
import { MetaGraphClient } from '../channel/meta-graph.client';
import { patchChannelMetadataSql } from '../channel/channel-metadata.util';
import { Priority } from '../rate-limit/rate-limit.types';
import { AutomationEventService } from '../messaging/automation-event.service';
import { AutomationJobs } from '../messaging/automation-jobs';
import { ChannelAccessService } from '../messaging/channel-access.service';
import { CommerceEventsService } from '../commerce/commerce-events.service';
import { CONVERSATIONS_STARTED, actionValue, adReferral, dayIn } from './ads.util';

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
/** Meta accepts business-messaging events at most 7 days old, and attributes to ad clicks in that window. */
const CLICK_WINDOW_MS = 7 * 86_400_000;
const INSIGHTS_TTL_MS = 15 * 60_000;

export interface AdRow {
    adId: string;
    headline: string | null;
    platform: ChannelPlatform | null;
    chats: number;
    orders: number;
    revenue: number;
    lastChatAt: Date | null;
    name: string | null;
    campaign: string | null;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    conversationsStarted: number | null;
}

/**
 * Click-to-WhatsApp, -Messenger and -Instagram ads. Every chat that starts
 * from an ad is recorded from its referral (no extra permission needed),
 * starts "Someone messages you from an ad" automations, and is credited with
 * the orders that customer places within 7 days. With an ad account connected
 * (Facebook Login with ads_read), the Ads page adds Meta's spend and
 * conversations. With conversions on for a WhatsApp number, a payment made in
 * the chat by someone who came from an ad is reported to the Conversions API
 * for business messaging, once.
 */
@Injectable()
export class AdsService implements OnModuleInit {
    private readonly logger = new Logger(AdsService.name);
    private readonly appId: string;
    private readonly appSecret: string;
    private readonly configId: string | undefined;
    private readonly insightsCache = new Map<string, { at: number; rows: Array<Record<string, unknown>> }>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly encryption: EncryptionService,
        private readonly metaGraph: MetaGraphClient,
        private readonly access: ChannelAccessService,
        private readonly automationEvents: AutomationEventService,
        private readonly jobs: AutomationJobs,
        private readonly commerceEvents: CommerceEventsService,
        config: ConfigService,
    ) {
        this.appId = config.get<string>('meta.appId') ?? '';
        this.appSecret = config.get<string>('meta.appSecret') ?? '';
        this.configId = config.get<string>('ads.configId');
    }

    onModuleInit() {
        this.commerceEvents.onPayment((linkId) => this.reportPurchase(linkId));
    }

    // ─── Referrals ─────────────────────────────────────────────────────

    /** The first message of a chat from an ad: record it and start the ad automations. Never throws. */
    async captureReferral(channel: { id: string; organizationId: string; platform: ChannelPlatform }, input: { conversationId: string; messageId: string | null; referral: unknown; at: Date }): Promise<void> {
        const ad = adReferral(channel.platform, input.referral);
        if (!ad) return;
        try {
            const conversation = await this.prisma.conversation.findUnique({ where: { id: input.conversationId }, select: { contactId: true, contact: { select: { externalId: true } } } });
            if (!conversation) return;
            const eventId = await this.prisma.$transaction(async (tx) => {
                await tx.adReferral.create({
                    data: {
                        organizationId: channel.organizationId,
                        channelId: channel.id,
                        platform: channel.platform,
                        contactId: conversation.contactId,
                        conversationId: input.conversationId,
                        messageId: input.messageId,
                        ...ad,
                        occurredAt: input.at,
                    },
                });
                const event = await this.automationEvents.record(tx, {
                    organizationId: channel.organizationId,
                    channelId: channel.id,
                    eventType: 'crm.ad.referral',
                    externalId: `ad:${input.messageId ?? `${conversation.contactId}:${input.at.getTime()}`}`,
                    occurredAt: input.at,
                    contactId: conversation.contactId,
                    ...(input.messageId ? { messageId: input.messageId } : {}),
                    actorExternalId: conversation.contact.externalId,
                    text: ad.adId,
                    // record() files this under payload.raw, where the engine reads {{ad.*}}.
                    payload: { vars: { 'ad.id': ad.adId, 'ad.headline': ad.headline ?? '', 'ad.body': ad.body ?? '', 'ad.url': ad.sourceUrl ?? '' } },
                });
                return event.id;
            });
            await this.jobs.event(eventId);
        } catch (err) {
            if (!isUniqueViolation(err)) this.logger.warn(`Ad referral on ${input.conversationId} not recorded: ${err instanceof Error ? err.message : err}`);
        }
    }

    /** A standalone referral (an existing thread, an ad tapped): filed on the sender's latest conversation. */
    async captureForSender(channel: { id: string; organizationId: string; platform: ChannelPlatform }, senderId: string, referral: unknown, at: Date): Promise<void> {
        const contact = await this.prisma.channelContact.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: senderId } }, select: { id: true } });
        if (!contact) return;
        const conversation = await this.prisma.conversation.findFirst({ where: { contactId: contact.id }, orderBy: { updatedAt: 'desc' }, select: { id: true } });
        if (conversation) await this.captureReferral(channel, { conversationId: conversation.id, messageId: null, referral, at });
    }

    /** The latest ad a contact came from, for the inbox. */
    async latestFor(contactId: string) {
        return this.prisma.adReferral.findFirst({
            where: { contactId },
            orderBy: { occurredAt: 'desc' },
            select: { adId: true, headline: true, body: true, sourceUrl: true, mediaUrl: true, occurredAt: true, platform: true },
        });
    }

    // ─── The Ads page ──────────────────────────────────────────────────

    async report(orgId: string, days: number) {
        const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true, currency: true } });
        const until = new Date();
        const since = new Date(until.getTime() - days * 86_400_000);
        const local = await this.prisma.$queryRaw<Array<{ ad_id: string; headline: string | null; platform: ChannelPlatform; chats: number; last_at: Date }>>`
            SELECT ad_id, max(headline) AS headline, max(platform::text)::"ChannelPlatform" AS platform,
                   count(DISTINCT contact_id)::int AS chats, max(occurred_at) AS last_at
            FROM ad_referrals WHERE organization_id = ${orgId} AND occurred_at >= ${since}
            GROUP BY ad_id`;
        // An order counts for an ad when its customer came from that ad in the 7 days before it,
        // so it can count for several ads; the row with no ad_id counts each order once, for the totals.
        const sales = await this.prisma.$queryRaw<Array<{ ad_id: string | null; orders: number; revenue: number }>>`
            WITH credited AS (
                SELECT DISTINCT r.ad_id, o.id, (o.total_price * coalesce(o.exchange_rate, 1))::float AS revenue
                FROM ad_referrals r
                JOIN channel_contacts c ON c.id = r.contact_id
                JOIN orders o ON o.customer_id = c.customer_id AND o.organization_id = r.organization_id
                WHERE r.organization_id = ${orgId} AND r.occurred_at >= ${since} AND o.cancelled_at IS NULL AND o.deleted_at IS NULL
                  AND coalesce(o.external_created_at, o.created_at) >= r.occurred_at
                  AND coalesce(o.external_created_at, o.created_at) < r.occurred_at + interval '7 days'
            )
            SELECT ad_id, count(*)::int AS orders, coalesce(sum(revenue), 0)::float AS revenue FROM credited GROUP BY ad_id
            UNION ALL
            SELECT NULL, count(*)::int, coalesce(sum(revenue), 0)::float FROM (SELECT DISTINCT id, revenue FROM credited) AS each_order`;
        const sold = sales.find((s) => s.ad_id === null) ?? { orders: 0, revenue: 0 };

        const account = await this.prisma.adAccount.findUnique({ where: { organizationId: orgId } });
        let insights: Array<Record<string, unknown>> = [];
        let metaError: string | null = null;
        if (account?.externalId) {
            try {
                insights = await this.insights(account, dayIn(org.timezone, since), dayIn(org.timezone, until));
            } catch (err) {
                metaError = err instanceof Error ? err.message : String(err);
            }
        }

        const rows = new Map<string, AdRow>();
        const row = (adId: string): AdRow => {
            let r = rows.get(adId);
            if (!r) {
                r = { adId, headline: null, platform: null, chats: 0, orders: 0, revenue: 0, lastChatAt: null, name: null, campaign: null, spend: null, impressions: null, clicks: null, conversationsStarted: null };
                rows.set(adId, r);
            }
            return r;
        };
        for (const l of local) Object.assign(row(l.ad_id), { headline: l.headline, platform: l.platform, chats: l.chats, lastChatAt: l.last_at });
        for (const s of sales) if (s.ad_id !== null) Object.assign(row(s.ad_id), { orders: s.orders, revenue: s.revenue });
        for (const i of insights) {
            const adId = String(i.ad_id ?? '');
            if (!adId) continue;
            Object.assign(row(adId), {
                name: typeof i.ad_name === 'string' ? i.ad_name : null,
                campaign: typeof i.campaign_name === 'string' ? i.campaign_name : null,
                spend: Number(i.spend ?? 0),
                impressions: Number(i.impressions ?? 0),
                clicks: Number(i.clicks ?? 0),
                conversationsStarted: actionValue(i.actions, CONVERSATIONS_STARTED),
            });
        }
        const ads = [...rows.values()].sort((a, b) => b.chats - a.chats || (b.spend ?? 0) - (a.spend ?? 0));
        const chats = ads.reduce((n, a) => n + a.chats, 0);
        const spend = account?.externalId ? ads.reduce((n, a) => n + (a.spend ?? 0), 0) : null;
        return {
            period: { from: since, to: until, days, timeZone: org.timezone },
            currency: org.currency,
            account: account ? { connected: true, externalId: account.externalId, name: account.name, currency: account.currency, available: account.available, lastError: account.lastError } : { connected: false },
            metaError,
            totals: { chats, orders: sold.orders, revenue: sold.revenue, spend },
            ads,
        };
    }

    /** GET /act_{id}/insights at ad level for the period; cached for 15 minutes. */
    private async insights(account: { id: string; externalId: string | null; credentials: string }, since: string, until: string) {
        const key = `${account.id}:${since}:${until}`;
        const hit = this.insightsCache.get(key);
        if (hit && Date.now() - hit.at < INSIGHTS_TTL_MS) return hit.rows;
        const token = this.encryption.decrypt(account.credentials);
        const rows: Array<Record<string, unknown>> = [];
        let after: string | undefined;
        for (let page = 0; page < 10; page++) {
            const res = await this.metaGraph.request<{ data?: Array<Record<string, unknown>>; paging?: { cursors?: { after?: string }; next?: string } }>({
                method: 'GET',
                path: `/${account.externalId}/insights`,
                query: {
                    level: 'ad',
                    fields: 'ad_id,ad_name,campaign_name,spend,impressions,clicks,actions',
                    time_range: JSON.stringify({ since, until }),
                    limit: '500',
                    ...(after ? { after } : {}),
                },
                accessToken: token,
                scopes: this.metaGraph.baseScopes(),
                priority: Priority.INTERACTIVE,
            });
            rows.push(...(res.data.data ?? []));
            after = res.data.paging?.next ? res.data.paging.cursors?.after : undefined;
            if (!after) break;
        }
        this.insightsCache.set(key, { at: Date.now(), rows });
        await this.prisma.adAccount.update({ where: { id: account.id }, data: { lastError: null } }).catch(() => undefined);
        return rows;
    }

    // ─── The ad account ────────────────────────────────────────────────

    async connectConfig(orgId: string, userId: string) {
        if (!this.configId) throw new BadRequestException('Ad results are not configured on the server. Missing META_ADS_CONFIG_ID (a Facebook Login for Business configuration with ads_read).');
        const state = randomBytes(16).toString('hex');
        await this.redis.set(`${REDIS_KEYS.OAUTH_META_ADS}${state}`, { userId, orgId }, REDIS_TTL.OAUTH_STATE);
        return { configId: this.configId, state };
    }

    async completeConnect(orgId: string, userId: string, code: string, state: string) {
        const stateKey = `${REDIS_KEYS.OAUTH_META_ADS}${state}`;
        const saved = await this.redis.get<{ userId: string; orgId: string }>(stateKey);
        if (!saved || saved.orgId !== orgId || saved.userId !== userId) throw new UnauthorizedException('Invalid or expired state parameter');
        await this.redis.del(stateKey);
        const { token, expiresAt } = await this.exchange(code);
        const res = await this.graph<{ data?: Array<{ id: string; name?: string; currency?: string; account_status?: number }> }>('/me/adaccounts', { fields: 'id,name,currency,account_status', limit: '100' }, token);
        const available = (res.data ?? []).filter((a) => a.account_status === undefined || a.account_status === 1).map((a) => ({ id: a.id, name: a.name ?? a.id, currency: a.currency ?? null }));
        if (!available.length) throw new BadRequestException('No active ad account was shared. Connect again and choose your ad account in the Meta popup.');
        const only = available.length === 1 ? available[0] : null;
        const data = {
            credentials: this.encryption.encrypt(token),
            tokenExpiresAt: expiresAt,
            available: available as unknown as Prisma.InputJsonValue,
            connectedById: userId,
            externalId: only?.id ?? null,
            name: only?.name ?? null,
            currency: only?.currency ?? null,
            lastError: null,
        };
        await this.prisma.adAccount.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, ...data }, update: data });
        this.insightsCache.clear();
        return this.accountView(orgId);
    }

    async chooseAccount(orgId: string, externalId: string) {
        const account = await this.prisma.adAccount.findUnique({ where: { organizationId: orgId } });
        if (!account) throw new NotFoundException('Connect an ad account first.');
        const chosen = (account.available as Array<{ id: string; name: string; currency: string | null }>).find((a) => a.id === externalId);
        if (!chosen) throw new BadRequestException('That ad account was not shared with Collabo.');
        await this.prisma.adAccount.update({ where: { id: account.id }, data: { externalId: chosen.id, name: chosen.name, currency: chosen.currency } });
        this.insightsCache.clear();
        return this.accountView(orgId);
    }

    async disconnect(orgId: string) {
        await this.prisma.adAccount.deleteMany({ where: { organizationId: orgId } });
        this.insightsCache.clear();
    }

    async accountView(orgId: string) {
        const a = await this.prisma.adAccount.findUnique({ where: { organizationId: orgId } });
        return a ? { connected: true, externalId: a.externalId, name: a.name, currency: a.currency, available: a.available, tokenExpiresAt: a.tokenExpiresAt, lastError: a.lastError } : { connected: false };
    }

    // ─── Conversions API ───────────────────────────────────────────────

    /** Per WhatsApp number: whether in-chat purchases are reported, and to which dataset. */
    async conversionSettings(orgId: string) {
        const numbers = await this.prisma.channel.findMany({ where: { organizationId: orgId, platform: ChannelPlatform.WHATSAPP }, select: { id: true, name: true, metadata: true } });
        const sent = await this.prisma.conversionEvent.groupBy({ by: ['channelId', 'status'], where: { organizationId: orgId }, _count: { _all: true } });
        return numbers.map((n) => {
            const c = (n.metadata as { conversions?: { datasetId?: string; enabledAt?: string } } | null)?.conversions;
            return {
                channelId: n.id,
                name: n.name,
                enabled: !!c?.datasetId,
                datasetId: c?.datasetId ?? null,
                sent: sent.filter((s) => s.channelId === n.id && s.status === 'SENT').reduce((x, s) => x + s._count._all, 0),
                failed: sent.filter((s) => s.channelId === n.id && s.status === 'FAILED').reduce((x, s) => x + s._count._all, 0),
            };
        });
    }

    /** POST /{waba_id}/dataset returns the dataset linked to the WhatsApp account, making it when there is none. */
    async setConversions(orgId: string, channelId: string, enabled: boolean) {
        const channel = await this.prisma.channel.findFirst({ where: { id: channelId, organizationId: orgId, platform: ChannelPlatform.WHATSAPP }, select: { id: true } });
        if (!channel) throw new NotFoundException('WhatsApp number not found');
        if (!enabled) {
            await this.prisma.$executeRaw(Prisma.sql`UPDATE "channels" SET "metadata" = "metadata" - 'conversions', "updated_at" = now() WHERE "id" = ${channelId}`);
            return this.conversionSettings(orgId);
        }
        const a = await this.access.get(channelId);
        let datasetId: string | undefined;
        try {
            const res = await this.metaGraph.request<{ id?: string }>({ method: 'POST', path: `/${a.wabaId}/dataset`, accessToken: a.token, scopes: a.scopes, priority: Priority.INTERACTIVE, channelId });
            datasetId = res.data.id;
        } catch (err) {
            throw new BadRequestException(`Meta did not give this WhatsApp account a dataset: ${err instanceof Error ? err.message : err}. The app needs whatsapp_business_manage_events.`);
        }
        if (!datasetId) throw new BadRequestException('Meta did not return a dataset for this WhatsApp account.');
        await this.prisma.$executeRaw(patchChannelMetadataSql(channelId, 'conversions', { datasetId, enabledAt: new Date().toISOString() }));
        return this.conversionSettings(orgId);
    }

    /**
     * A payment made in the chat: if the buyer came from a click-to-WhatsApp
     * ad in the last 7 days and the number reports conversions, send one
     * Purchase with the ad's click id. Website orders are not sent: Meta wants
     * messaging events to be things that happened in the chat.
     */
    async reportPurchase(linkId: string): Promise<void> {
        const link = await this.prisma.paymentLink.findUnique({ where: { id: linkId } });
        if (!link?.conversationId || link.status !== 'PAID') return;
        const conversation = await this.prisma.conversation.findUnique({ where: { id: link.conversationId }, select: { contactId: true, channel: { select: { id: true, platform: true, metadata: true } } } });
        if (!conversation || conversation.channel.platform !== ChannelPlatform.WHATSAPP) return;
        const datasetId = (conversation.channel.metadata as { conversions?: { datasetId?: string } } | null)?.conversions?.datasetId;
        if (!datasetId) return;
        const paidAt = link.paidAt ?? new Date();
        const click = await this.prisma.adReferral.findFirst({
            where: { contactId: conversation.contactId, ctwaClid: { not: null }, occurredAt: { gt: new Date(paidAt.getTime() - CLICK_WINDOW_MS), lte: paidAt } },
            orderBy: { occurredAt: 'desc' },
        });
        if (!click?.ctwaClid) return;
        let row;
        try {
            row = await this.prisma.conversionEvent.create({
                data: {
                    organizationId: link.organizationId,
                    channelId: conversation.channel.id,
                    paymentLinkId: link.id,
                    orderId: link.orderId,
                    eventName: 'Purchase',
                    datasetId,
                    ctwaClid: click.ctwaClid,
                    value: link.amount,
                    currency: link.currency,
                    status: 'PENDING',
                },
            });
        } catch (err) {
            if (isUniqueViolation(err)) return;
            throw err;
        }
        try {
            const a = await this.access.get(conversation.channel.id);
            await this.metaGraph.request({
                method: 'POST',
                path: `/${datasetId}/events`,
                body: {
                    data: [{
                        event_name: 'Purchase',
                        event_time: Math.floor(paidAt.getTime() / 1000),
                        action_source: 'business_messaging',
                        messaging_channel: 'whatsapp',
                        user_data: { whatsapp_business_account_id: a.wabaId, ctwa_clid: click.ctwaClid },
                        custom_data: { currency: link.currency, value: Number(link.amount) },
                    }],
                    partner_agent: 'collabo',
                },
                accessToken: a.token,
                scopes: a.scopes,
                priority: Priority.NORMAL,
                channelId: conversation.channel.id,
            });
            await this.prisma.conversionEvent.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date() } });
        } catch (err) {
            await this.prisma.conversionEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: (err instanceof Error ? err.message : String(err)).slice(0, 500) } });
        }
    }

    // ─── Meta helpers ──────────────────────────────────────────────────

    /** The login code becomes a user token, swapped for a long-lived one (about 60 days). */
    private async exchange(code: string): Promise<{ token: string; expiresAt: Date | null }> {
        const first = await this.graph<{ access_token: string; expires_in?: number }>('/oauth/access_token', { client_id: this.appId, client_secret: this.appSecret, code });
        if (!first.expires_in) return { token: first.access_token, expiresAt: null };
        const long = await this.graph<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
            grant_type: 'fb_exchange_token',
            client_id: this.appId,
            client_secret: this.appSecret,
            fb_exchange_token: first.access_token,
        });
        return { token: long.access_token, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null };
    }

    private async graph<T>(path: string, query: Record<string, string>, accessToken?: string): Promise<T> {
        try {
            return (await this.metaGraph.request<T>({ method: 'GET', path, query, accessToken, scopes: this.metaGraph.baseScopes(), priority: Priority.INTERACTIVE })).data;
        } catch (err) {
            this.logger.warn(`Meta ${path} failed: ${err instanceof Error ? err.message : err}`);
            throw new BadRequestException('Meta refused the ad account connection. Please try again.');
        }
    }
}
