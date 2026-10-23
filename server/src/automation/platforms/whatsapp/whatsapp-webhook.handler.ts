import { Injectable, Logger } from '@nestjs/common';
import { ChannelPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { patchChannelMetadataSql, recordHistoryChunkSql } from '../../../channel/channel-metadata.util';
import { accountUpdateEffect } from './whatsapp-account-update.util';
import type { WaEvent } from './whatsapp-webhook.parser';

export interface WhatsAppChannelRef {
    id: string;
    organizationId: string;
    externalStoreId: string | null;
    credentials: Prisma.JsonValue;
}

const MESSAGE_KINDS = new Set<WaEvent['kind']>([
    'message',
    'echo',
    'status',
    'history_chunk',
    'history_media',
    'contact_sync',
    'user_preference',
]);

/**
 * Applies a parsed WhatsApp delivery. Account-level events — connection
 * lifecycle, number health, history-sync progress — are handled here.
 */
@Injectable()
export class WhatsAppWebhookHandler {
    private readonly logger = new Logger(WhatsAppWebhookHandler.name);

    constructor(private readonly prisma: PrismaService) { }

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

            for (const e of mine) {
                await this.handleAccountEvent(channel, e);
            }
            const messageEvents = mine.filter((e) => MESSAGE_KINDS.has(e.kind));
            if (messageEvents.length) {
                this.logger.log(`WhatsApp channel ${channel.id}: ${messageEvents.length} message events received`);
            }
        }
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
                // Stored on the template rows by the templates service.
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
