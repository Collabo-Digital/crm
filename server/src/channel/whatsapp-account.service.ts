import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RESTRICTION_ERRORS, healthClearsRestriction } from '../automation/platforms/whatsapp/whatsapp-account-update.util';
import { EncryptionService } from './encryption.service';
import { MetaGraphClient } from './meta-graph.client';
import { MetaGraphError, metaScope } from './meta-graph.types';
import { Priority, RateLimitScope } from '../rate-limit/rate-limit.types';
import { patchChannelMetadataSql } from './channel-metadata.util';

/** The fields every WhatsApp row's `credentials` carries. */
export interface WhatsAppCredentials {
    wabaId: string;
    phoneNumberId: string;
    displayPhoneNumber?: string;
    verifiedName?: string;
    /** Encrypted business integration system user token. */
    accessToken: string;
    /** Encrypted two-step verification PIN we registered the number with. */
    registrationPin?: string | null;
    /** The number also runs on the WhatsApp Business app (coexistence). */
    isOnBizApp?: boolean;
    [key: string]: unknown;
}

export interface PhoneNumberDetails {
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    code_verification_status?: string;
    platform_type?: string;
    throughput?: { level?: string };
    name_status?: string;
    is_on_biz_app?: boolean;
    whatsapp_business_manager_messaging_limit?: string;
    /** Whether Meta lets this number send, and what blocks it (payment method, policy…). */
    health_status?: {
        can_send_message?: string;
        entities?: Array<{
            entity_type?: string;
            can_send_message?: string;
            errors?: Array<{ error_code?: number; error_description?: string; possible_solution?: string }>;
        }>;
    };
}

/// Present on every version we run; requested together.
const NUMBER_FIELDS =
    'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput,name_status';
/// Newer fields, asked for separately: an unknown field fails the whole read.
const NUMBER_FIELDS_OPTIONAL = 'is_on_biz_app,whatsapp_business_manager_messaging_limit,health_status';

/** Coexistence contacts + history must be requested within 24 hours of onboarding. */
export const COEXISTENCE_SYNC_WINDOW_MS = 24 * 3600_000;

export type SyncType = 'smb_app_state_sync' | 'history';

/**
 * Operations on a connected WhatsApp number after (and during) onboarding:
 * subscribing the app to the account's webhooks, registering the number,
 * reading its health, and the one-shot coexistence contact/history sync.
 */
@Injectable()
export class WhatsAppAccountService {
    private readonly logger = new Logger(WhatsAppAccountService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly encryption: EncryptionService,
        private readonly metaGraph: MetaGraphClient,
    ) { }

    scopes(wabaId: string, phoneNumberId?: string): RateLimitScope[] {
        return [
            ...this.metaGraph.baseScopes(),
            metaScope.buc(wabaId),
            ...(phoneNumberId ? [metaScope.phone(phoneNumberId)] : []),
        ];
    }

    /** Without this Meta sends the account's webhooks to nobody. */
    async subscribeApp(wabaId: string, token: string): Promise<void> {
        await this.metaGraph.request<{ success?: boolean }>({
            method: 'POST',
            path: `/${wabaId}/subscribed_apps`,
            accessToken: token,
            scopes: this.scopes(wabaId),
            priority: Priority.INTERACTIVE,
        });
    }

    async unsubscribeApp(wabaId: string, token: string): Promise<void> {
        await this.metaGraph.request({
            method: 'DELETE',
            path: `/${wabaId}/subscribed_apps`,
            accessToken: token,
            scopes: this.scopes(wabaId),
            priority: Priority.NORMAL,
        });
    }

    /**
     * Register a Cloud API number. The PIN becomes its two-step verification
     * PIN, so it is kept (encrypted) for any later re-registration. Never
     * called for coexistence numbers: they are already registered by the app.
     */
    async registerNumber(wabaId: string, phoneNumberId: string, token: string, pin: string): Promise<void> {
        await this.metaGraph.request({
            method: 'POST',
            path: `/${phoneNumberId}/register`,
            accessToken: token,
            body: { messaging_product: 'whatsapp', pin },
            scopes: this.scopes(wabaId, phoneNumberId),
            priority: Priority.INTERACTIVE,
        });
    }

    static newPin(): string {
        return String(randomInt(0, 1_000_000)).padStart(6, '0');
    }

    async fetchNumber(wabaId: string, phoneNumberId: string, token: string): Promise<PhoneNumberDetails> {
        const base = await this.metaGraph.request<PhoneNumberDetails>({
            method: 'GET',
            path: `/${phoneNumberId}`,
            query: { fields: NUMBER_FIELDS },
            accessToken: token,
            scopes: this.scopes(wabaId, phoneNumberId),
            priority: Priority.INTERACTIVE,
        });
        try {
            const extra = await this.metaGraph.request<PhoneNumberDetails>({
                method: 'GET',
                path: `/${phoneNumberId}`,
                query: { fields: NUMBER_FIELDS_OPTIONAL },
                accessToken: token,
                scopes: this.scopes(wabaId, phoneNumberId),
                priority: Priority.INTERACTIVE,
            });
            return { ...base.data, ...extra.data };
        } catch (err) {
            if (!(err instanceof MetaGraphError)) throw err;
            this.logger.warn(`Optional number fields unavailable for ${phoneNumberId}: ${err.message}`);
            return base.data;
        }
    }

    /**
     * The numbers on an account, first one first. A signup's number must be
     * one of them: Meta's number read does not say which account it is on.
     */
    async numberIds(wabaId: string, token: string): Promise<string[]> {
        const ids: string[] = [];
        let after: string | undefined;
        for (let page = 0; page < 10; page++) {
            const res = await this.metaGraph.request<{
                data?: Array<{ id: string }>;
                paging?: { next?: string; cursors?: { after?: string } };
            }>({
                method: 'GET',
                path: `/${wabaId}/phone_numbers`,
                query: { fields: 'id', limit: 100, after },
                accessToken: token,
                scopes: this.scopes(wabaId),
                priority: Priority.INTERACTIVE,
            });
            ids.push(...(res.data.data ?? []).map((n) => n.id));
            after = res.data.paging?.next ? res.data.paging.cursors?.after : undefined;
            if (!after) break;
        }
        return ids;
    }

    /** A connected WhatsApp row with its decrypted token. */
    async load(channelId: string) {
        const channel = await this.prisma.channel.findFirst({
            where: { id: channelId, platform: ChannelPlatform.WHATSAPP },
            select: { id: true, organizationId: true, status: true, credentials: true, metadata: true, connectedAt: true },
        });
        if (!channel?.credentials) throw new NotFoundException('WhatsApp channel not found or not connected');
        const creds = channel.credentials as unknown as WhatsAppCredentials;
        return { channel, creds, token: this.encryption.decrypt(creds.accessToken) };
    }

    /** Re-read quality, limits and name status into metadata.health.number. */
    async refreshHealth(channelId: string): Promise<PhoneNumberDetails> {
        const { creds, token } = await this.load(channelId);
        const number = await this.fetchNumber(creds.wabaId, creds.phoneNumberId, token);
        await this.prisma.$executeRaw(
            patchChannelMetadataSql(channelId, 'health', {
                number: { ...number, checkedAt: new Date().toISOString() },
            }),
        );
        if (healthClearsRestriction(number.health_status?.can_send_message)) {
            // A lifted restriction whose webhook never came.
            await this.prisma.channel.updateMany({
                where: { id: channelId, status: ChannelStatus.ERROR, lastError: { in: RESTRICTION_ERRORS } },
                data: { status: ChannelStatus.CONNECTED, lastError: null },
            });
        }
        return number;
    }

    /**
     * Ask Meta for one coexistence sync. Each type may run once per onboarding;
     * the request id is stored so a retried job never asks twice.
     */
    async requestSync(channelId: string, syncType: SyncType): Promise<string> {
        const { creds, token } = await this.load(channelId);
        const res = await this.metaGraph.request<{ request_id?: string }>({
            method: 'POST',
            path: `/${creds.phoneNumberId}/smb_app_data`,
            accessToken: token,
            body: { messaging_product: 'whatsapp', sync_type: syncType },
            scopes: this.scopes(creds.wabaId, creds.phoneNumberId),
            priority: Priority.INTERACTIVE,
        });
        const requestId = res.data.request_id ?? 'accepted';
        const at = new Date().toISOString();
        await this.prisma.$executeRaw(
            patchChannelMetadataSql(
                channelId,
                'historySync',
                syncType === 'history'
                    ? { historyRequestId: requestId, historyRequestedAt: at, status: 'requested' }
                    : { contactsRequestId: requestId, contactsRequestedAt: at },
            ),
        );
        return requestId;
    }

    /**
     * Contacts first, then history — the order Meta documents — skipping any
     * step already done. Throws to let the queue retry; the caller records a
     * final failure.
     */
    async runCoexistenceSync(channelId: string, now = new Date()): Promise<'done' | 'expired' | 'skipped'> {
        const { channel, creds } = await this.load(channelId);
        if (!creds.isOnBizApp) return 'skipped';
        const sync = readObject(readObject(channel.metadata).historySync);
        const startedAt = typeof sync.onboardedAt === 'string' ? new Date(sync.onboardedAt) : channel.connectedAt;
        if (startedAt && now.getTime() - startedAt.getTime() > COEXISTENCE_SYNC_WINDOW_MS && !sync.historyRequestId) {
            await this.prisma.$executeRaw(
                patchChannelMetadataSql(channelId, 'historySync', {
                    status: 'expired',
                    error: 'The 24-hour window to import chat history has passed. Disconnect and connect WhatsApp again to import it.',
                }),
            );
            return 'expired';
        }
        if (!sync.contactsRequestId) await this.requestSync(channelId, 'smb_app_state_sync');
        if (!sync.historyRequestId) await this.requestSync(channelId, 'history');
        return 'done';
    }

    async markSyncFailed(channelId: string, error: string): Promise<void> {
        await this.prisma.$executeRaw(
            patchChannelMetadataSql(channelId, 'historySync', { status: 'failed', error: error.slice(0, 500) }),
        );
    }
}

function readObject(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

