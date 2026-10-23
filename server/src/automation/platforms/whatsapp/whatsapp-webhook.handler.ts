import { Injectable, Logger } from '@nestjs/common';
import { ChannelPlatform, MessageSource, MessageStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { patchChannelMetadataSql, recordHistoryChunkSql } from '../../../channel/channel-metadata.util';
import { IngestChannel, MessageIngestService } from '../../../messaging/message-ingest.service';
import { TemplatesService } from '../../../campaigns/templates/templates.service';
import { ContactRef } from '../../../messaging/contact-identity.service';
import { whatsAppContent } from '../../../messaging/message-content';
import { accountUpdateEffect } from './whatsapp-account-update.util';
import type { WaContactRef, WaEvent, WaMessage } from './whatsapp-webhook.parser';

export interface WhatsAppChannelRef {
    id: string;
    organizationId: string;
    externalStoreId: string | null;
    credentials: Prisma.JsonValue;
}

const STATUS_MAP: Record<string, MessageStatus> = {
    sent: MessageStatus.SENT,
    delivered: MessageStatus.DELIVERED,
    read: MessageStatus.READ,
    // A voice note played counts as read.
    played: MessageStatus.READ,
    failed: MessageStatus.FAILED,
};

/** A history item's state on the device, as a message status. */
const HISTORY_STATUS: Record<string, MessageStatus> = {
    SENT: MessageStatus.SENT,
    DELIVERED: MessageStatus.DELIVERED,
    READ: MessageStatus.READ,
    PLAYED: MessageStatus.READ,
    ERROR: MessageStatus.FAILED,
    PENDING: MessageStatus.QUEUED,
};

const toRef = (c: WaContactRef | null): ContactRef => ({
    platform: ChannelPlatform.WHATSAPP,
    userId: c?.userId ?? null,
    waId: c?.waId ?? null,
    username: c?.username ?? null,
    profileName: c?.profileName ?? null,
});

/**
 * Applies a parsed WhatsApp delivery: account-level events — connection
 * lifecycle, number health, history-sync progress — onto the channel, and
 * messages, echoes, statuses and history into the inbox.
 */
@Injectable()
export class WhatsAppWebhookHandler {
    private readonly logger = new Logger(WhatsAppWebhookHandler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly ingest: MessageIngestService,
        private readonly templates: TemplatesService,
    ) { }

    async handle(events: WaEvent[]): Promise<void> {
        const byWaba = new Map<string, WaEvent[]>();
        for (const e of events) {
            const list = byWaba.get(e.wabaId) ?? [];
            list.push(e);
            byWaba.set(e.wabaId, list);
        }

        for (const [wabaId, list] of byWaba) {
            const channel = await this.prisma.channel.findFirst({
                where: { platform: ChannelPlatform.WHATSAPP, externalStoreId: wabaId },
                select: { id: true, organizationId: true, externalStoreId: true, credentials: true },
            });
            if (!channel) {
                this.logger.warn(`WhatsApp webhook for WABA ${wabaId}: no connected channel (${list.length} events dropped)`);
                continue;
            }
            const phoneNumberId = readPhoneNumberId(channel.credentials);
            // A WABA can hold several numbers; only the connected one is ours.
            const mine = list.filter((e) => !e.phoneNumberId || !phoneNumberId || e.phoneNumberId === phoneNumberId);
            if (mine.length < list.length) {
                this.logger.log(`WhatsApp webhook for WABA ${wabaId}: ${list.length - mine.length} events for another number ignored`);
            }

            const ingestChannel: IngestChannel = {
                id: channel.id,
                organizationId: channel.organizationId,
                platform: ChannelPlatform.WHATSAPP,
                address: phoneNumberId ?? wabaId,
            };
            for (const e of mine) {
                await this.handleAccountEvent(channel, e);
                await this.handleMessageEvent(ingestChannel, e);
            }
        }
    }

    private async handleMessageEvent(channel: IngestChannel, e: WaEvent): Promise<void> {
        switch (e.kind) {
            case 'message':
                await this.applyInbound(channel, e.message);
                return;
            case 'echo':
                await this.applyBusinessMessage(channel, e.message, false);
                return;
            case 'status':
                await this.ingest.applyStatus(channel, e.status.messageId, {
                    status: STATUS_MAP[e.status.status] ?? MessageStatus.SENT,
                    at: e.status.timestamp,
                    pricing: e.status.pricing as Record<string, unknown> | null,
                    error: e.status.errors[0]
                        ? { code: e.status.errors[0].code !== null ? String(e.status.errors[0].code) : null, message: e.status.errors[0].details ?? e.status.errors[0].message }
                        : null,
                });
                return;
            case 'history_chunk':
                // Chunks arrive out of order and can hold thousands of messages;
                // each item is idempotent on its wamid, so order does not matter.
                for (const thread of e.threads) {
                    for (const m of thread.messages) {
                        if (m.from === null) await this.applyBusinessMessage(channel, m, true);
                        else await this.applyInbound(channel, m, true);
                    }
                }
                return;
            case 'history_media':
                for (const m of e.messages) await this.ingest.applyLateMedia(channel, m.id, whatsAppContent(m));
                return;
            case 'contact_sync':
                await this.ingest.applyAddressBook(
                    channel,
                    e.contacts.map((c) => ({ action: c.action, name: c.fullName ?? c.firstName, contact: toRef(c.contact) })),
                );
                return;
            case 'user_preference':
                if (e.category === 'marketing_messages') {
                    await this.ingest.applyMarketingPreference(channel, toRef(e.contact), e.value, e.at ?? new Date());
                }
                return;
            default:
                return;
        }
    }

    private async applyInbound(channel: IngestChannel, m: WaMessage, imported = false): Promise<void> {
        const raw = m.raw;
        switch (m.type) {
            case 'reaction': {
                const reaction = raw.reaction as { message_id?: string; emoji?: string } | undefined;
                if (reaction?.message_id) await this.ingest.applyReaction(channel, reaction.message_id, reaction.emoji ?? null, 'customer');
                return;
            }
            case 'edit': {
                const edit = raw.edit as { original_message_id?: string } | undefined;
                if (edit?.original_message_id) await this.ingest.applyEdit(channel, edit.original_message_id, m.text, m.timestamp);
                return;
            }
            case 'revoke': {
                const revoke = raw.revoke as { original_message_id?: string } | undefined;
                if (revoke?.original_message_id) await this.ingest.applyRevoke(channel, revoke.original_message_id, m.timestamp);
                return;
            }
        }
        let from = m.from;
        if (m.type === 'system') {
            const system = raw.system as { type?: string; user_id?: string; previous_user_id?: string; wa_id?: string } | undefined;
            if (system?.type === 'user_changed_number' || system?.type === 'user_changed_user_id') {
                await this.ingest.rekeyContact(channel, {
                    previousUserId: system.previous_user_id ?? null,
                    userId: system.user_id ?? null,
                    waId: system.wa_id ?? null,
                });
                // File the notice under the contact's new identity.
                from = {
                    userId: system.user_id ?? m.from?.userId ?? null,
                    waId: system.wa_id ?? m.from?.waId ?? null,
                    username: m.from?.username ?? null,
                    profileName: m.from?.profileName ?? null,
                };
            }
        }
        if (!from || (!from.userId && !from.waId)) return;
        const button = raw.button as { payload?: string } | undefined;
        await this.ingest.recordInbound({
            channel,
            contact: toRef(from),
            externalId: m.id,
            occurredAt: m.timestamp,
            content: whatsAppContent(m),
            body: raw,
            replyToExternalId: m.context?.id ?? null,
            imported,
            initialStatus: imported && m.historyStatus ? (HISTORY_STATUS[m.historyStatus] ?? MessageStatus.DELIVERED) : undefined,
            consentPayload: button?.payload ?? null,
            // A cart from the catalog starts cart automations, not message ones.
            event: imported ? undefined : { type: m.type === 'order' ? 'whatsapp.cart' : 'whatsapp.message', extraPayload: { referral: m.referral } },
        });
    }

    /** Sent from the WhatsApp Business app (coexistence), live or from history. */
    private async applyBusinessMessage(channel: IngestChannel, m: WaMessage, imported: boolean): Promise<void> {
        if (m.type === 'edit' || m.type === 'revoke') {
            const ref = (m.raw[m.type] as { original_message_id?: string } | undefined)?.original_message_id;
            if (!ref) return;
            if (m.type === 'edit') await this.ingest.applyEdit(channel, ref, m.text, m.timestamp);
            else await this.ingest.applyRevoke(channel, ref, m.timestamp);
            return;
        }
        if (!m.to || (!m.to.userId && !m.to.waId)) return;
        await this.ingest.recordBusinessMessage({
            channel,
            contact: toRef(m.to),
            externalId: m.id,
            occurredAt: m.timestamp,
            content: whatsAppContent(m),
            body: m.raw,
            replyToExternalId: m.context?.id ?? null,
            imported,
            source: MessageSource.BUSINESS_APP,
            status: imported && m.historyStatus ? (HISTORY_STATUS[m.historyStatus] ?? MessageStatus.SENT) : MessageStatus.SENT,
        });
    }

    private async handleAccountEvent(channel: WhatsAppChannelRef, e: WaEvent): Promise<void> {
        const now = new Date().toISOString();
        switch (e.kind) {
            case 'account_update': {
                const effect = accountUpdateEffect(e.event, e.reason);
                await this.prisma.$executeRaw(
                    patchChannelMetadataSql(channel.id, 'accountEvents', {
                        [e.event ?? 'UNKNOWN']: { at: now, reason: e.reason, initiatedBy: e.initiatedBy },
                    }),
                );
                if (!effect) return;
                await this.prisma.channel.update({
                    where: { id: channel.id },
                    data: {
                        ...(effect.status ? { status: effect.status } : {}),
                        ...(effect.lastError !== undefined ? { lastError: effect.lastError } : {}),
                    },
                });
                await this.prisma.$executeRaw(
                    patchChannelMetadataSql(channel.id, 'coexistence', {
                        ...(effect.coexistence ?? {}),
                        sendsPaused: effect.pauseSends,
                        updatedAt: now,
                    }),
                );
                this.logger.log(`WhatsApp channel ${channel.id}: account_update ${e.event} (${e.reason ?? 'no reason'})`);
                return;
            }
            case 'number_update': {
                const key =
                    e.field === 'phone_number_quality_update'
                        ? 'quality'
                        : e.field === 'phone_number_name_update'
                            ? 'displayName'
                            : e.field === 'business_capability_update'
                                ? 'capability'
                                : 'alerts';
                await this.prisma.$executeRaw(
                    patchChannelMetadataSql(channel.id, 'health', { [key]: { ...e.value, receivedAt: now } }),
                );
                return;
            }
            case 'history_chunk': {
                const messages = e.threads.reduce((n, t) => n + t.messages.length, 0);
                await this.prisma.$executeRaw(
                    recordHistoryChunkSql(channel.id, { phase: e.phase, progress: e.progress, messages }),
                );
                return;
            }
            case 'history_declined': {
                await this.prisma.$executeRaw(
                    patchChannelMetadataSql(channel.id, 'historySync', {
                        status: 'declined',
                        declinedAt: now,
                        error: e.errors[0]?.message ?? null,
                    }),
                );
                return;
            }
            case 'template_update':
                await this.templates.applyWebhook(channel, e);
                return;
            case 'value_errors':
                this.logger.warn(
                    `WhatsApp channel ${channel.id}: webhook errors ${e.errors.map((x) => `${x.code} ${x.title}`).join('; ')}`,
                );
                return;
            case 'other':
                this.logger.log(`WhatsApp channel ${channel.id}: unhandled field ${e.field}`);
                return;
            default:
                return;
        }
    }
}

function readPhoneNumberId(credentials: Prisma.JsonValue): string | null {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null;
    const value = (credentials as Record<string, unknown>).phoneNumberId;
    return typeof value === 'string' ? value : null;
}
