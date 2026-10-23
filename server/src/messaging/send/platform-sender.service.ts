import { Injectable, Logger } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus, MessageDirection, MessageSource, MessageStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaGraphClient } from '../../channel/meta-graph.client';
import { MetaGraphError } from '../../channel/meta-graph.types';
import { Priority, isRateLimitedError } from '../../rate-limit/rate-limit.types';
import { ChannelAccess, ChannelAccessService } from '../channel-access.service';
import { InboxEventsService } from '../inbox-events.service';
import { BroadcastTracker } from '../broadcast-tracker';
import { MessagingMediaStorage } from '../media/messaging-media.storage';
import { OutboundPayload, buildMessengerBody, buildWhatsAppBody } from '../outbound';
import { patchChannelMetadataSql } from '../../channel/channel-metadata.util';

/**
 * Meta errors that will fail the same way however often they are retried.
 * Source: WhatsApp and Messenger error code references.
 */
const PERMANENT_META_CODES = new Set<number>([
    100, // invalid parameter
    10, // permission denied
    200, // permissions error
    551, // person unavailable (Messenger)
    10900, // comment already has a private reply
    10903, // private reply window passed
    131008, // required parameter missing
    131009, // parameter value invalid
    131026, // undeliverable: not on WhatsApp / old app
    131047, // outside the 24-hour window
    131049, // not delivered to keep engagement healthy
    131050, // user stopped marketing messages
    131051, // unsupported message type
    131052, // media download error
    131053, // media upload error
    131062, // BSUID recipients not supported for this message
    131063, // marketing disabled on Cloud API: use the Marketing Messages API
    132000, // template parameter count mismatch
    132001, // template does not exist
    132005, // template hydrated text too long
    132007, // template format character policy violated
    132012, // template parameter format mismatch
    132015, // template paused
    132016, // template disabled
    2018278, // Messenger: outside the allowed window
    2534037, // Instagram: thread owned by Meta Business AI
]);

/** Why a send failed, as the merchant should read it in the thread. */
export function describeSendFailure(code: number | undefined, fallback: string): string {
    switch (code) {
        case 131047:
        case 2018278:
            return 'The reply window had closed by the time this was sent.';
        case 131026:
            return 'This number cannot receive WhatsApp messages.';
        case 131049:
            return 'WhatsApp held this marketing message back to protect engagement. Try again in a day or two.';
        case 131050:
            return 'This customer has stopped marketing messages from you.';
        case 132015:
        case 132016:
            return 'This template is paused or disabled because of low quality.';
        case 131063:
            return 'Marketing messages must go through the Marketing Messages API for this account.';
        case 10900:
            return 'This comment already has a private reply.';
        case 10903:
            return 'Private replies are only possible within 7 days of the comment.';
        case 2534037:
            return 'Meta Business AI owns this conversation. Take it over in Meta Business Suite first.';
        default:
            return fallback;
    }
}

const isUniqueViolation = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Delivers queued message rows to Meta and records the outcome. Rate limits
 * propagate (the worker parks the job); transient errors propagate (BullMQ
 * retries); permanent errors are written to the row.
 */
@Injectable()
export class PlatformSenderService {
    private readonly logger = new Logger(PlatformSenderService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ChannelAccessService,
        private readonly metaGraph: MetaGraphClient,
        private readonly storage: MessagingMediaStorage,
        private readonly events: InboxEventsService,
        private readonly broadcasts: BroadcastTracker,
    ) { }

    async deliver(messageId: string, humanAgentTag: boolean): Promise<'sent' | 'failed' | 'skipped'> {
        const message = await this.prisma.message.findUnique({
            where: { id: messageId },
            include: { contact: true },
        });
        if (!message || message.status !== MessageStatus.QUEUED || !message.contact) return 'skipped';
        const payload = (message.body as { payload?: OutboundPayload }).payload;
        if (!payload) return this.fail(message, undefined, 'Nothing to send.');

        const channel = await this.access.get(message.channelId);
        try {
            const externalId =
                payload.type === 'comment_reply'
                    ? await this.replyToComment(channel, payload)
                    : channel.platform === ChannelPlatform.WHATSAPP
                        ? await this.sendWhatsApp(channel, message.contact, payload, message.replyToExternalId)
                        : await this.sendMessenger(channel, message.contact.externalId, payload, message.replyToExternalId, humanAgentTag);
            await this.markSent(message.id, message.channelId, externalId);
            if (payload.type === 'reaction') {
                await this.applyBusinessReaction(channel, payload.targetExternalId, payload.emoji);
            }
            this.publish(message.organizationId, message.conversationId, message.id);
            return 'sent';
        } catch (err) {
            if (isRateLimitedError(err)) throw err;
            if (err instanceof MetaGraphError) {
                if (err.code === 'AUTH_FAILED') {
                    await this.prisma.channel.update({
                        where: { id: channel.id },
                        data: { status: ChannelStatus.ERROR, lastError: 'Meta rejected this account’s access. Reconnect it in Settings → Channels.' },
                    });
                    return this.fail(message, err.metaCode, 'The account’s access was revoked or expired. Reconnect it.');
                }
                if (err.code === 'API_ERROR' && (err.metaCode === undefined || PERMANENT_META_CODES.has(err.metaCode) || (err.httpStatus ?? 0) < 500)) {
                    return this.fail(message, err.metaCode, describeSendFailure(err.metaCode, err.message));
                }
            }
            if (err instanceof UnsupportedSend) return this.fail(message, undefined, err.message);
            throw err;
        }
    }

    /** Blue ticks on WhatsApp, "seen" on Messenger and Instagram. */
    async markRead(channelId: string, contactExternalId: string, messageExternalId: string | null): Promise<void> {
        const channel = await this.access.get(channelId);
        if (channel.platform === ChannelPlatform.WHATSAPP) {
            if (!messageExternalId) return;
            await this.metaGraph.request({
                method: 'POST',
                path: channel.sendPath,
                accessToken: channel.token,
                body: { messaging_product: 'whatsapp', status: 'read', message_id: messageExternalId },
                scopes: channel.scopes,
                priority: Priority.NORMAL,
                channelId,
            });
            return;
        }
        await this.metaGraph.request({
            method: 'POST',
            ...(channel.baseUrl ? { url: `${channel.baseUrl}${channel.sendPath}` } : { path: channel.sendPath }),
            accessToken: channel.token,
            body: { recipient: { id: contactExternalId }, sender_action: 'mark_seen' },
            scopes: channel.scopes,
            pageId: channel.pageId ?? undefined,
            priority: Priority.NORMAL,
            channelId,
        });
    }

    private async sendWhatsApp(
        channel: ChannelAccess,
        contact: { externalId: string; waId: string | null; id: string },
        payload: OutboundPayload,
        replyToExternalId: string | null,
    ): Promise<string> {
        const isBsuid = /^[A-Z]{2}\./.test(contact.externalId);
        const recipient = {
            waId: contact.waId ?? (isBsuid ? null : contact.externalId),
            userId: isBsuid ? contact.externalId : null,
        };
        const mediaId = payload.type === 'media' ? await this.uploadWhatsAppMedia(channel, payload) : null;
        const toSend = payload.type === 'template' && payload.headerMedia ? await this.withHeaderMedia(channel, payload) : payload;
        const body = buildWhatsAppBody(toSend, recipient, { replyToExternalId, mediaId });
        const marketing = payload.type === 'template' && payload.category === 'MARKETING';
        const send = (viaMarketingApi: boolean) =>
            this.metaGraph.request<{
                messages?: Array<{ id: string }>;
                contacts?: Array<{ wa_id?: string; user_id?: string }>;
            }>({
                method: 'POST',
                // Marketing Messages API: same body plus a product policy; it falls
                // back to the Cloud API by itself for accounts not onboarded.
                path: viaMarketingApi ? `/${channel.address}/marketing_messages` : channel.sendPath,
                accessToken: channel.token,
                body: viaMarketingApi ? { ...body, product_policy: 'CLOUD_API_FALLBACK' } : body,
                scopes: channel.scopes,
                priority: Priority.INTERACTIVE,
                channelId: channel.id,
            });
        let res: Awaited<ReturnType<typeof send>>;
        try {
            res = await send(marketing && channel.marketingMessagesApi);
        } catch (err) {
            // 131063: this account no longer takes marketing on /messages. Remember, and use the other API.
            if (!(marketing && err instanceof MetaGraphError && err.metaCode === 131063)) throw err;
            await this.prisma.$executeRaw(
                patchChannelMetadataSql(channel.id, 'marketingMessages', { required: true, at: new Date().toISOString() }),
            );
            res = await send(true);
        }
        const id = res.data.messages?.[0]?.id;
        if (!id) throw new MetaGraphError('WhatsApp returned no message id', 'API_ERROR');
        const waId = res.data.contacts?.[0]?.wa_id;
        if (waId && waId !== contact.waId) {
            await this.prisma.channelContact.update({ where: { id: contact.id }, data: { waId, phone: `+${waId}` } });
        }
        return id;
    }

    private async sendMessenger(
        channel: ChannelAccess,
        recipientId: string,
        payload: OutboundPayload,
        replyToExternalId: string | null,
        humanAgentTag: boolean,
    ): Promise<string> {
        const attachmentId = payload.type === 'media' ? await this.uploadMessengerAttachment(channel, payload) : null;
        const res = await this.metaGraph.request<{ message_id?: string; recipient_id?: string }>({
            method: 'POST',
            ...(channel.baseUrl ? { url: `${channel.baseUrl}${channel.sendPath}` } : { path: channel.sendPath }),
            accessToken: channel.token,
            body: buildMessengerBody(payload, recipientId, { humanAgentTag, replyToExternalId, attachmentId }),
            scopes: channel.scopes,
            pageId: channel.pageId ?? undefined,
            priority: Priority.INTERACTIVE,
            channelId: channel.id,
        });
        // Reactions answer without a message id; there is no row to key.
        return res.data.message_id ?? `${payload.type}:${Date.now()}`;
    }

    /**
     * Upload a stored file to the WhatsApp number once and get its media id,
     * for a broadcast whose every message carries the same header.
     */
    async uploadForWhatsApp(channelId: string, file: { storageKey: string; mime: string; kind: 'image' | 'video' | 'document'; filename?: string }): Promise<string> {
        const channel = await this.access.get(channelId);
        return this.uploadWhatsAppMedia(channel, {
            type: 'media',
            mediaKind: file.kind,
            storageKey: file.storageKey,
            mime: file.mime,
            filename: file.filename,
        });
    }

    /** Upload a template's header file and put its media id into the header parameter. */
    private async withHeaderMedia(
        channel: ChannelAccess,
        payload: Extract<OutboundPayload, { type: 'template' }>,
    ): Promise<OutboundPayload> {
        const media = payload.headerMedia!;
        const id = await this.uploadWhatsAppMedia(channel, {
            type: 'media',
            mediaKind: media.kind,
            storageKey: media.storageKey,
            mime: media.mime,
            filename: media.filename,
        });
        const rest = (payload.components ?? []).filter((c) => (c as { type?: string }).type !== 'header');
        // A document keeps its name ("Invoice-INV-0042.pdf") on the customer's phone.
        const file = media.kind === 'document' && media.filename ? { id, filename: media.filename } : { id };
        const header = { type: 'header', parameters: [{ type: media.kind, [media.kind]: file }] };
        const { headerMedia: _h, ...template } = payload;
        return { ...template, components: [header, ...rest] };
    }

    /**
     * Block a number on WhatsApp: `POST /{phone_number_id}/block_users`. Meta
     * only allows it for people who messaged in the last 24 hours, and its
     * docs name phone numbers only, so a contact known just by its BSUID is
     * not attempted.
     */
    async blockOnWhatsApp(channelId: string, contact: { waId: string | null }): Promise<void> {
        if (!contact.waId) throw new MetaGraphError('WhatsApp blocking needs the phone number, which this contact has not shared.', 'API_ERROR');
        const channel = await this.access.get(channelId);
        await this.metaGraph.request({
            method: 'POST',
            path: `/${channel.address}/block_users`,
            accessToken: channel.token,
            body: { messaging_product: 'whatsapp', block_users: [{ user: contact.waId }] },
            scopes: channel.scopes,
            priority: Priority.INTERACTIVE,
            channelId: channel.id,
        });
    }

    /**
     * A public reply under a comment: Facebook `POST /{comment-id}/comments`,
     * Instagram `POST /{ig-comment-id}/replies`. Our own reply comes back on
     * the comments webhook from the account itself, which the handler skips.
     */
    private async replyToComment(channel: ChannelAccess, payload: Extract<OutboundPayload, { type: 'comment_reply' }>): Promise<string> {
        const path = channel.platform === ChannelPlatform.INSTAGRAM ? `/${payload.commentId}/replies` : `/${payload.commentId}/comments`;
        const res = await this.metaGraph.request<{ id?: string }>({
            method: 'POST',
            ...(channel.baseUrl ? { url: `${channel.baseUrl}${path}` } : { path }),
            accessToken: channel.token,
            body: { message: payload.text },
            scopes: channel.scopes,
            pageId: channel.pageId ?? undefined,
            priority: Priority.INTERACTIVE,
            channelId: channel.id,
        });
        if (!res.data.id) throw new MetaGraphError('Meta returned no comment id', 'API_ERROR');
        return res.data.id;
    }

    private async uploadWhatsAppMedia(channel: ChannelAccess, payload: Extract<OutboundPayload, { type: 'media' }>): Promise<string> {
        const file = await this.storage.read(payload.storageKey);
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', payload.mime);
        form.append('file', new Blob([new Uint8Array(file)], { type: payload.mime }), payload.filename ?? 'file');
        const res = await this.metaGraph.request<{ id?: string }>({
            method: 'POST',
            path: `/${channel.address}/media`,
            accessToken: channel.token,
            multipart: form,
            scopes: channel.scopes,
            priority: Priority.INTERACTIVE,
            channelId: channel.id,
            timeoutMs: 60_000,
        });
        if (!res.data.id) throw new MetaGraphError('WhatsApp returned no media id', 'API_ERROR');
        return res.data.id;
    }

    private async uploadMessengerAttachment(
        channel: ChannelAccess,
        payload: Extract<OutboundPayload, { type: 'media' }>,
    ): Promise<string> {
        if (!channel.pageId) {
            throw new UnsupportedSend('Files can only be sent to Instagram accounts connected through a Facebook Page.');
        }
        const file = await this.storage.read(payload.storageKey);
        const type = payload.mediaKind === 'document' ? 'file' : payload.mediaKind;
        const form = new FormData();
        form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }));
        form.append('filedata', new Blob([new Uint8Array(file)], { type: payload.mime }), payload.filename ?? 'file');
        const res = await this.metaGraph.request<{ attachment_id?: string }>({
            method: 'POST',
            path: `/${channel.pageId}/message_attachments`,
            query: channel.platform === ChannelPlatform.INSTAGRAM ? { platform: 'instagram' } : undefined,
            accessToken: channel.token,
            multipart: form,
            scopes: channel.scopes,
            pageId: channel.pageId,
            priority: Priority.INTERACTIVE,
            channelId: channel.id,
            timeoutMs: 60_000,
        });
        if (!res.data.attachment_id) throw new MetaGraphError('Meta returned no attachment id', 'API_ERROR');
        return res.data.attachment_id;
    }

    /**
     * Messenger and Instagram echo our own sends back as webhooks, and the echo
     * can land before this response. If it did, it was stored as a separate
     * row under the same platform id: drop that copy and keep ours.
     */
    private async markSent(messageId: string, channelId: string, externalId: string) {
        const data = { status: MessageStatus.SENT, externalId, sentAt: new Date() };
        await this.broadcasts.onStatus(messageId, MessageStatus.SENT, data.sentAt);
        try {
            await this.prisma.message.update({ where: { id: messageId }, data });
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            await this.prisma.message.deleteMany({
                where: {
                    channelId,
                    externalId,
                    id: { not: messageId },
                    direction: MessageDirection.OUTBOUND,
                    source: { in: [MessageSource.OTHER_APP, MessageSource.BUSINESS_APP] },
                },
            });
            await this.prisma.message.update({ where: { id: messageId }, data });
        }
    }

    private async applyBusinessReaction(channel: ChannelAccess, targetExternalId: string, emoji: string) {
        const target = await this.prisma.message.findFirst({
            where: { channelId: channel.id, externalId: targetExternalId },
            select: { id: true, reactions: true },
        });
        if (!target) return;
        const reactions = { ...((target.reactions as Record<string, string | null> | null) ?? {}), business: emoji || null };
        await this.prisma.message.update({ where: { id: target.id }, data: { reactions } });
    }

    private async fail(
        message: { id: string; organizationId: string; conversationId: string | null; contactId: string | null },
        code: number | undefined,
        reason: string,
    ): Promise<'failed'> {
        await this.prisma.message.update({
            where: { id: message.id },
            data: {
                status: MessageStatus.FAILED,
                failedAt: new Date(),
                errorCode: code !== undefined ? String(code) : null,
                errorMessage: reason,
            },
        });
        if (message.contactId) {
            await this.prisma.channelContact.update({
                where: { id: message.contactId },
                data: { outboundFailedCount: { increment: 1 }, consecutiveFailures: { increment: 1 } },
            });
        }
        await this.broadcasts.onStatus(message.id, MessageStatus.FAILED, new Date(), {
            code: code !== undefined ? String(code) : null,
            message: reason,
        });
        this.publish(message.organizationId, message.conversationId, message.id);
        this.logger.warn(`Message ${message.id} failed${code ? ` (${code})` : ''}: ${reason}`);
        return 'failed';
    }

    private publish(orgId: string, conversationId: string | null, messageId: string) {
        if (conversationId) this.events.publish(orgId, { type: 'message.updated', conversationId, messageId });
    }
}

/** A send this account cannot make at all; recorded as a failure, never retried. */
export class UnsupportedSend extends Error { }
