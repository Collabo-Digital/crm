import { Injectable, Logger } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus, MessageDirection, MessageSource, MessageStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeter } from '../../billing/usage-meter';
import { MetaGraphClient } from '../../channel/meta-graph.client';
import { MetaGraphError } from '../../channel/meta-graph.types';
import { Priority, isRateLimitedError } from '../../rate-limit/rate-limit.types';
import { ChannelAccess, ChannelAccessService } from '../channel-access.service';
import { InboxEventsService } from '../inbox-events.service';
import { BroadcastTracker } from '../broadcast-tracker';
import { MessagingMediaStorage } from '../media/messaging-media.storage';
import { VoiceNoteConverter, VoiceNoteError } from '../media/voice-note.converter';
import { OutboundPayload, buildMessengerBody, buildWhatsAppBody } from '../outbound';
import { groupIdOfContact } from '../group-contact';
import { clearRecipientFailures, isRecipientFailure, noteRecipientFailure } from '../recipient-failures';
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

/** Why a send failed, as the merchant should read it in the thread. `details` is Meta's error_data.details. */
export function describeSendFailure(code: number | undefined, fallback: string, details?: string | null): string {
    const why = (details ?? '').trim();
    switch (code) {
        case 131047:
        case 2018278:
            return 'The reply window had closed by the time this was sent. Send a template instead.';
        case 131026:
            return 'This number cannot receive WhatsApp messages, or is on an old version of WhatsApp.';
        case 131049:
            return 'WhatsApp held this marketing message back to protect engagement. Try again in a day or two.';
        case 131050:
            return 'This customer has stopped marketing messages from you.';
        case 132015:
        case 132016:
            return 'This template is paused or disabled because of low quality.';
        case 131063:
            return 'Marketing messages must go through the Marketing Messages API for this account.';
        case 131009:
        case 131008:
        case 100:
            return `WhatsApp refused part of this message${why ? `: ${why}` : ''}. Check its buttons, links and length.`;
        case 131042:
            return 'Meta blocked this message because of a problem with the WhatsApp account’s payment method. Fix it in WhatsApp Manager → Payment settings.';
        case 131031:
            return 'Meta has locked this WhatsApp account. Check its status in WhatsApp Manager.';
        case 131037:
            return 'This number’s display name is not approved yet, so WhatsApp will not send messages from it.';
        case 131048:
            return 'WhatsApp is limiting messages from this number because many were blocked or reported as spam. Send fewer for a while.';
        case 131056:
            return 'Too many messages went to this customer in a short time. Wait a moment, then send again.';
        case 131051:
            return 'WhatsApp does not support this kind of message.';
        case 131053:
            return 'The file could not be sent. Check its type and size.';
        case 130472:
            return 'WhatsApp did not deliver this marketing message: the customer is in one of Meta’s experiments.';
        case 130497:
            return 'This WhatsApp account may not message customers in this country.';
        case 133010:
            return 'This WhatsApp number is not registered with the Cloud API. Reconnect it.';
        case 368:
            return 'Meta has temporarily blocked this account for policy violations. Check WhatsApp Manager.';
        case 132000:
        case 132012:
            return `The template’s values do not match what Meta approved${why ? `: ${why}` : ''}.`;
        case 132001:
            return 'This template does not exist or is not approved in this language. Sync templates and try again.';
        case 132005:
            return 'With its values filled in, this template is too long.';
        case 132007:
            return 'A value in this template breaks WhatsApp’s formatting rules (for example a line break or too many spaces).';
        case 131000:
            return 'WhatsApp could not send this for an unknown reason. Send it again.';
        case 10900:
            return 'This comment already has a private reply.';
        case 10903:
            return 'Private replies are only possible within 7 days of the comment.';
        case 2534037:
            return 'Meta Business AI owns this conversation. Take it over in Meta Business Suite first.';
        default:
            return why && !fallback.includes(why) ? `${fallback} (${why})` : fallback;
    }
}

/** Meta's error_data.details from a Graph error body, when it has one. */
export function metaErrorDetails(raw: unknown): string | null {
    const details = (raw as { error_data?: { details?: unknown } } | undefined)?.error_data?.details;
    return typeof details === 'string' && details.trim() ? details.trim() : null;
}

const isUniqueViolation = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** A send whose outcome Collabo never learned, as the merchant reads it. */
export const UNCONFIRMED_SEND =
    'We could not confirm this message was sent, so it was not sent again automatically. It may still have reached the customer.';

/// Connection errors raised before anything was sent.
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/// Tries at writing Meta's message id before the job is left to retry.
const RECORD_ATTEMPTS = 3;

/**
 * Whether a send that failed after it was handed to Meta may still have
 * reached the customer: a timeout, a dropped connection, a 5xx Meta did not
 * explain. A refusal Meta answered with, a rate limit, or a connection that
 * never opened sent nothing.
 */
export function maySendHaveGoneOut(err: unknown): boolean {
    if (isRateLimitedError(err) || err instanceof UnsupportedSend) return false;
    if (err instanceof MetaGraphError) {
        if (err.code === 'TIMEOUT') return true;
        if (err.code === 'HTTP_ERROR') return (err.httpStatus ?? 0) >= 500;
        return false;
    }
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    return !(typeof code === 'string' && NOT_CONNECTED.has(code));
}

/** When an earlier attempt handed this row to Meta, if one did. */
function handedOverAt(responsePayload: Prisma.JsonValue | null): string | null {
    const at = (responsePayload as { handedOverAt?: unknown } | null)?.handedOverAt;
    return typeof at === 'string' ? at : null;
}

/** Another attempt is already sending this row. */
class AlreadyHandedOver extends Error { }

/**
 * Delivers queued message rows to Meta and records the outcome. Rate limits
 * propagate (the worker parks the job); transient errors propagate (BullMQ
 * retries); permanent errors are written to the row.
 *
 * A row is marked handed over (responsePayload.handedOverAt) just before the
 * request that sends it. A later attempt that finds the mark, or a failure
 * that may have happened after Meta took the message, fails the row as
 * unconfirmed instead of sending again: the customer must never get it twice.
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
        private readonly usageMeter: UsageMeter,
        private readonly voiceNotes: VoiceNoteConverter,
    ) { }

    async deliver(messageId: string, humanAgentTag: boolean): Promise<'sent' | 'failed' | 'skipped'> {
        const message = await this.prisma.message.findUnique({
            where: { id: messageId },
            include: { contact: true },
        });
        if (!message || message.status !== MessageStatus.QUEUED) return 'skipped';
        if (handedOverAt(message.responsePayload)) return this.fail(message, undefined, UNCONFIRMED_SEND);
        const contact = message.contact;
        if (!contact) return this.fail(message, undefined, 'The contact was deleted, so this message was not sent.');
        const payload = (message.body as { payload?: OutboundPayload }).payload;
        if (!payload) return this.fail(message, undefined, 'Nothing to send.');

        const channel = await this.access.get(message.channelId);
        let handedOver = false;
        const handOver = async () => {
            handedOver = await this.claim(message.id);
            if (!handedOver) throw new AlreadyHandedOver();
        };
        let sent: { externalId: string; waId?: string };
        try {
            sent =
                payload.type === 'comment_reply'
                    ? { externalId: await this.replyToComment(channel, payload, handOver) }
                    : channel.platform === ChannelPlatform.WHATSAPP
                        ? await this.sendWhatsApp(channel, contact, payload, message.replyToExternalId, handOver)
                        : { externalId: await this.sendMessenger(channel, contact.externalId, payload, message.replyToExternalId, humanAgentTag, handOver) };
        } catch (err) {
            if (err instanceof AlreadyHandedOver) return 'skipped';
            if (isRateLimitedError(err)) {
                if (handedOver) await this.release(message.id);
                throw err;
            }
            if (err instanceof MetaGraphError) {
                if (err.code === 'AUTH_FAILED') {
                    await this.prisma.channel.update({
                        where: { id: channel.id },
                        data: { status: ChannelStatus.ERROR, lastError: 'Meta rejected this account’s access. Reconnect it in Settings → Channels.' },
                    });
                    return this.fail(message, err.metaCode, 'The account’s access was revoked or expired. Reconnect it.');
                }
                if (err.code === 'API_ERROR' && (err.metaCode === undefined || PERMANENT_META_CODES.has(err.metaCode) || (err.httpStatus ?? 0) < 500)) {
                    return this.fail(message, err.metaCode, describeSendFailure(err.metaCode, err.message, metaErrorDetails(err.details)), err.subcode);
                }
            }
            if (err instanceof UnsupportedSend) return this.fail(message, undefined, err.message);
            if (handedOver && maySendHaveGoneOut(err)) {
                this.logger.warn(`Message ${message.id}: outcome unknown, not sent again: ${err instanceof Error ? err.message : err}`);
                return this.fail(message, undefined, UNCONFIRMED_SEND);
            }
            if (handedOver) await this.release(message.id);
            throw err;
        }

        await this.recordSent(message.id, message.channelId, sent.externalId);
        // Messenger and Instagram took it, so it reached the person; WhatsApp says so later, with "delivered".
        if (channel.platform !== ChannelPlatform.WHATSAPP && (contact.consecutiveFailures > 0 || contact.mutedUntil)) {
            await clearRecipientFailures(this.prisma, contact.id);
        }
        if (sent.waId && sent.waId !== contact.waId) {
            await this.prisma.channelContact
                .update({ where: { id: contact.id }, data: { waId: sent.waId, phone: `+${sent.waId}` } })
                .catch((err) => this.logger.warn(`Contact ${contact.id}: phone number from WhatsApp not saved: ${err}`));
        }
        if (channel.platform === ChannelPlatform.WHATSAPP) {
            await this.usageMeter.noteMessage(message.organizationId, contact.id, new Date());
        }
        if (payload.type === 'reaction') {
            await this.applyBusinessReaction(channel, payload.targetExternalId, payload.emoji);
        }
        this.publish(message.organizationId, message.conversationId, message.id);
        return 'sent';
    }

    /**
     * Fails a message the queue gave up on (retries spent, or rate limited for
     * too long), if it is still waiting to go out.
     */
    async giveUp(messageId: string, reason: string, code?: number): Promise<void> {
        const message = await this.prisma.message.findUnique({
            where: { id: messageId },
            select: { id: true, organizationId: true, conversationId: true, contactId: true, status: true },
        });
        if (message?.status === MessageStatus.QUEUED) await this.fail(message, code, reason);
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
        handOver: () => Promise<void>,
    ): Promise<{ externalId: string; waId?: string }> {
        const groupId = groupIdOfContact(contact.externalId);
        const isBsuid = /^[A-Z]{2}\./.test(contact.externalId);
        const recipient = groupId
            ? { waId: null, userId: null, groupId }
            : { waId: contact.waId ?? (isBsuid ? null : contact.externalId), userId: isBsuid ? contact.externalId : null };
        const mediaId = payload.type === 'media' ? await this.uploadWhatsAppMedia(channel, payload) : null;
        const toSend = payload.type === 'template' && payload.headerMedia ? await this.withHeaderMedia(channel, payload) : payload;
        const body = buildWhatsAppBody(toSend, recipient, { replyToExternalId, mediaId });
        // Meta documents group sends on /messages only.
        const marketing = !groupId && payload.type === 'template' && payload.category === 'MARKETING';
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
                idempotent: false,
            });
        let res: Awaited<ReturnType<typeof send>>;
        await handOver();
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
        return { externalId: id, waId: groupId ? undefined : res.data.contacts?.[0]?.wa_id };
    }

    private async sendMessenger(
        channel: ChannelAccess,
        recipientId: string,
        payload: OutboundPayload,
        replyToExternalId: string | null,
        humanAgentTag: boolean,
        handOver: () => Promise<void>,
    ): Promise<string> {
        const attachmentId = payload.type === 'media' ? await this.uploadMessengerAttachment(channel, payload) : null;
        await handOver();
        const res = await this.metaGraph.request<{ message_id?: string; recipient_id?: string }>({
            method: 'POST',
            ...(channel.baseUrl ? { url: `${channel.baseUrl}${channel.sendPath}` } : { path: channel.sendPath }),
            accessToken: channel.token,
            body: buildMessengerBody(payload, recipientId, { humanAgentTag, replyToExternalId, attachmentId }),
            scopes: channel.scopes,
            pageId: channel.pageId ?? undefined,
            priority: Priority.INTERACTIVE,
            channelId: channel.id,
            idempotent: false,
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
    private async replyToComment(
        channel: ChannelAccess,
        payload: Extract<OutboundPayload, { type: 'comment_reply' }>,
        handOver: () => Promise<void>,
    ): Promise<string> {
        const path = channel.platform === ChannelPlatform.INSTAGRAM ? `/${payload.commentId}/replies` : `/${payload.commentId}/comments`;
        await handOver();
        const res = await this.metaGraph.request<{ id?: string }>({
            method: 'POST',
            ...(channel.baseUrl ? { url: `${channel.baseUrl}${path}` } : { path }),
            accessToken: channel.token,
            body: { message: payload.text },
            scopes: channel.scopes,
            pageId: channel.pageId ?? undefined,
            priority: Priority.INTERACTIVE,
            channelId: channel.id,
            idempotent: false,
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
        const stored = await this.storage.read(payload.storageKey);
        const { file, mime, filename } = payload.voice
            ? { file: await this.asM4a(stored), mime: 'audio/mp4', filename: 'voice-note.m4a' }
            : { file: stored, mime: payload.mime, filename: payload.filename ?? 'file' };
        const type = payload.mediaKind === 'document' ? 'file' : payload.mediaKind;
        const form = new FormData();
        form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }));
        form.append('filedata', new Blob([new Uint8Array(file)], { type: mime }), filename);
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

    /** Instagram and Messenger take audio as AAC, not the Ogg/Opus a voice note is stored as. */
    private async asM4a(voiceNote: Buffer): Promise<Buffer> {
        try {
            return await this.voiceNotes.toM4a(voiceNote);
        } catch (err) {
            if (err instanceof VoiceNoteError) throw new UnsupportedSend('This voice message could not be converted for Instagram or Messenger. Record it again.');
            throw err;
        }
    }

    /** Marks the row as on its way to Meta. False when another attempt already has. */
    private async claim(messageId: string): Promise<boolean> {
        const { count } = await this.prisma.message.updateMany({
            where: { id: messageId, status: MessageStatus.QUEUED, responsePayload: { equals: Prisma.AnyNull } },
            data: { responsePayload: { handedOverAt: new Date().toISOString() } },
        });
        return count === 1;
    }

    /** Meta refused or never got the message: the next attempt may send it. */
    private async release(messageId: string) {
        await this.prisma.message
            .updateMany({ where: { id: messageId, status: MessageStatus.QUEUED }, data: { responsePayload: Prisma.DbNull } })
            .catch((err) => this.logger.warn(`Message ${messageId}: hand-over mark not cleared: ${err}`));
    }

    /**
     * Meta has the message: write its id before anything else, and try again
     * on a database error, because a retried job must never send it twice.
     */
    private async recordSent(messageId: string, channelId: string, externalId: string) {
        const data = { status: MessageStatus.SENT, externalId, sentAt: new Date() };
        for (let attempt = 1; ; attempt++) {
            try {
                await this.writeSent(messageId, channelId, data);
                break;
            } catch (err) {
                if (attempt >= RECORD_ATTEMPTS) throw err;
                this.logger.warn(`Message ${messageId} (${externalId}) sent but not yet recorded: ${err}`);
                await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            }
        }
        await this.broadcasts.onStatus(messageId, MessageStatus.SENT, data.sentAt);
    }

    /**
     * Messenger and Instagram echo our own sends back as webhooks, and the echo
     * can land before this response. If it did, it was stored as a separate
     * row under the same platform id: drop that copy and keep ours.
     */
    private async writeSent(messageId: string, channelId: string, data: { status: MessageStatus; externalId: string; sentAt: Date }) {
        try {
            await this.prisma.message.update({ where: { id: messageId }, data });
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            await this.prisma.message.deleteMany({
                where: {
                    channelId,
                    externalId: data.externalId,
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
        subcode?: number,
    ): Promise<'failed'> {
        const { count } = await this.prisma.message.updateMany({
            where: { id: message.id, status: MessageStatus.QUEUED },
            data: {
                status: MessageStatus.FAILED,
                failedAt: new Date(),
                errorCode: code !== undefined ? String(code) : null,
                errorMessage: reason,
            },
        });
        if (!count) return 'failed';
        if (message.contactId) {
            await this.prisma.channelContact.update({ where: { id: message.contactId }, data: { outboundFailedCount: { increment: 1 } } });
            if (isRecipientFailure(code, subcode)) await noteRecipientFailure(this.prisma, message.contactId, new Date());
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
