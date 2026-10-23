import { ChannelPlatform, ChannelStatus } from '@prisma/client';

/**
 * What can be sent, who may send it when, and how each platform wants it.
 * Pure: the send service supplies the state, the worker supplies media ids.
 */

const HOUR = 3600_000;
/** Free-form replies are allowed for 24 hours after the customer's last message. */
export const SERVICE_WINDOW_MS = 24 * HOUR;
/** Messenger / Instagram: a person (never an automation) may reply for 7 days. */
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * HOUR;

export interface ReplyWindow {
    open: boolean;
    closesAt: Date | null;
    /** Messenger / Instagram only: the HUMAN_AGENT tag extends replies to here. */
    humanAgentUntil: Date | null;
}

/**
 * The customer-service window. Only messages the customer sent to the live
 * API count: on a coexistence number, chats imported from the WhatsApp
 * Business app and the business's own phone replies open nothing.
 */
export function replyWindow(platform: ChannelPlatform, lastInboundAt: Date | null, now = new Date()): ReplyWindow {
    if (!lastInboundAt) return { open: false, closesAt: null, humanAgentUntil: null };
    const closesAt = new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS);
    const humanAgentUntil =
        platform === ChannelPlatform.WHATSAPP ? null : new Date(lastInboundAt.getTime() + HUMAN_AGENT_WINDOW_MS);
    return { open: now < closesAt, closesAt, humanAgentUntil };
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface QuickReplyOption {
    title: string;
    payload: string;
}

export type OutboundPayload =
    | { type: 'text'; text: string; previewUrl?: boolean }
    | { type: 'media'; mediaKind: MediaKind; storageKey: string; mime: string; filename?: string; caption?: string }
    | {
        type: 'template';
        name: string;
        language: string;
        /** Meta's template `components` with parameters filled in. */
        components?: unknown[];
        /** MARKETING / UTILITY / AUTHENTICATION, for the consent rule. */
        category?: string;
    }
    | { type: 'buttons'; text: string; buttons: Array<{ id: string; title: string }>; footer?: string }
    | {
        type: 'list';
        text: string;
        buttonText: string;
        sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>;
    }
    | { type: 'quick_replies'; text: string; replies: QuickReplyOption[] }
    | { type: 'location'; latitude: number; longitude: number; name?: string; address?: string }
    | { type: 'reaction'; targetExternalId: string; emoji: string }
    /** One private reply to an Instagram or Facebook comment. */
    | { type: 'private_reply'; commentId: string; text: string };

export type SendOrigin = 'agent' | 'automation' | 'broadcast' | 'system';

export interface GateInput {
    platform: ChannelPlatform;
    payload: OutboundPayload;
    origin: SendOrigin;
    channel: { status: ChannelStatus; isEnabled: boolean; sendsPaused: boolean };
    contact: { blockedAt: Date | null; optedOutAt: Date | null };
    window: ReplyWindow;
    now?: Date;
}

export type GateResult =
    | { ok: true; humanAgentTag: boolean }
    | { ok: false; code: SendRefusal; message: string };

export type SendRefusal =
    | 'channel_unavailable'
    | 'contact_blocked'
    | 'opted_out'
    | 'window_closed'
    | 'unsupported_on_platform'
    | 'invalid_payload';

const refuse = (code: SendRefusal, message: string): GateResult => ({ ok: false, code, message });

function hoursAgo(since: Date | null, now: Date): string {
    if (!since) return '';
    const hours = Math.round((now.getTime() - since.getTime()) / HOUR);
    return hours < 48 ? ` ${hours} hours ago` : ` ${Math.round(hours / 24)} days ago`;
}

/** May this message go now? The reason, in words for the composer, when not. */
export function checkSend(input: GateInput): GateResult {
    const { platform, payload, origin, channel, contact, window } = input;
    const now = input.now ?? new Date();

    if (channel.status !== ChannelStatus.CONNECTED || !channel.isEnabled) {
        return refuse('channel_unavailable', 'This account is not connected. Reconnect it in Settings → Channels.');
    }
    if (channel.sendsPaused) {
        return refuse('channel_unavailable', 'Sending is paused while WhatsApp reconnects this number.');
    }
    if (contact.blockedAt) return refuse('contact_blocked', 'This contact is blocked.');

    const shape = checkShape(platform, payload);
    if (shape) return shape;

    if (payload.type === 'template') {
        if (payload.category === 'MARKETING' && contact.optedOutAt) {
            return refuse('opted_out', 'This customer opted out of marketing messages.');
        }
        return { ok: true, humanAgentTag: false };
    }
    if (payload.type === 'private_reply' || payload.type === 'reaction') {
        // Private replies have their own 7-day rule, enforced by Meta per comment.
        return { ok: true, humanAgentTag: false };
    }
    if (window.open) return { ok: true, humanAgentTag: false };

    if (platform === ChannelPlatform.WHATSAPP) {
        return refuse(
            'window_closed',
            `The 24-hour reply window closed${hoursAgo(window.closesAt, now)}. Send an approved template to restart the conversation.`,
        );
    }
    if (origin === 'agent' && window.humanAgentUntil && now < window.humanAgentUntil) {
        return { ok: true, humanAgentTag: true };
    }
    return refuse(
        'window_closed',
        origin === 'agent'
            ? 'More than 7 days have passed since the customer last wrote. Wait for them to message again.'
            : 'The 24-hour reply window has closed. Automations cannot message this customer until they write again.',
    );
}

function checkShape(platform: ChannelPlatform, payload: OutboundPayload): GateResult | null {
    const wa = platform === ChannelPlatform.WHATSAPP;
    switch (payload.type) {
        case 'text':
            if (!payload.text.trim()) return refuse('invalid_payload', 'Write a message first.');
            // Instagram counts UTF-8 bytes; emoji and Indic scripts use several each.
            if (platform === ChannelPlatform.INSTAGRAM && Buffer.byteLength(payload.text, 'utf8') > 1000) {
                return refuse('invalid_payload', 'Instagram messages can be at most 1,000 bytes. Shorten the message.');
            }
            if (payload.text.length > (wa ? 4096 : 2000)) {
                return refuse('invalid_payload', `Messages can be at most ${wa ? 4096 : 2000} characters here.`);
            }
            return null;
        case 'template':
        case 'list':
        case 'location':
            return wa ? null : refuse('unsupported_on_platform', 'This message type is only available on WhatsApp.');
        case 'buttons':
            if (payload.buttons.length < 1 || payload.buttons.length > 3) {
                return refuse('invalid_payload', 'Use one to three buttons.');
            }
            if (payload.buttons.some((b) => b.title.length > 20)) {
                return refuse('invalid_payload', 'Button labels can be at most 20 characters.');
            }
            return null;
        case 'quick_replies':
            if (wa) return refuse('unsupported_on_platform', 'Use buttons or a list on WhatsApp.');
            if (payload.replies.length < 1 || payload.replies.length > 13) {
                return refuse('invalid_payload', 'Use one to thirteen quick replies.');
            }
            return null;
        case 'private_reply':
            return wa ? refuse('unsupported_on_platform', 'Private replies are for Instagram and Facebook comments.') : null;
        default:
            return null;
    }
}

/** Where a WhatsApp message goes: the phone number when we have it, else the BSUID. */
export interface WhatsAppRecipient {
    waId: string | null;
    userId: string | null;
}

/** The body for POST /{phone_number_id}/messages. */
export function buildWhatsAppBody(
    payload: OutboundPayload,
    recipient: WhatsAppRecipient,
    ctx: { replyToExternalId?: string | null; mediaId?: string | null } = {},
): Record<string, unknown> {
    // Meta: when both are sent, `to` wins; phone numbers also keep phone
    // numbers flowing in later webhooks.
    const address = recipient.waId ? { to: recipient.waId } : { recipient: recipient.userId };
    const base = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...address,
        ...(ctx.replyToExternalId ? { context: { message_id: ctx.replyToExternalId } } : {}),
    };
    switch (payload.type) {
        case 'text':
            return { ...base, type: 'text', text: { body: payload.text, preview_url: payload.previewUrl ?? true } };
        case 'media':
            return {
                ...base,
                type: payload.mediaKind,
                [payload.mediaKind]: {
                    id: ctx.mediaId,
                    ...(payload.caption && payload.mediaKind !== 'audio' ? { caption: payload.caption } : {}),
                    ...(payload.mediaKind === 'document' && payload.filename ? { filename: payload.filename } : {}),
                },
            };
        case 'template':
            return {
                ...base,
                type: 'template',
                template: {
                    name: payload.name,
                    language: { code: payload.language },
                    ...(payload.components?.length ? { components: payload.components } : {}),
                },
            };
        case 'buttons':
            return {
                ...base,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: payload.text },
                    ...(payload.footer ? { footer: { text: payload.footer } } : {}),
                    action: {
                        buttons: payload.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
                    },
                },
            };
        case 'list':
            return {
                ...base,
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: { text: payload.text },
                    action: { button: payload.buttonText, sections: payload.sections },
                },
            };
        case 'location':
            return {
                ...base,
                type: 'location',
                location: { latitude: payload.latitude, longitude: payload.longitude, name: payload.name, address: payload.address },
            };
        case 'reaction':
            return { ...base, type: 'reaction', reaction: { message_id: payload.targetExternalId, emoji: payload.emoji } };
        default:
            throw new Error(`${payload.type} cannot be sent on WhatsApp`);
    }
}

/** The body for POST /{page_id}/messages (Messenger, and Instagram through a Page). */
export function buildMessengerBody(
    payload: OutboundPayload,
    recipientId: string,
    ctx: { humanAgentTag?: boolean; replyToExternalId?: string | null; attachmentId?: string | null } = {},
): Record<string, unknown> {
    const messaging = ctx.humanAgentTag
        ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' }
        : { messaging_type: 'RESPONSE' };
    const replyTo = ctx.replyToExternalId ? { reply_to: { mid: ctx.replyToExternalId } } : {};
    switch (payload.type) {
        case 'text':
            return { recipient: { id: recipientId }, ...messaging, ...replyTo, message: { text: payload.text } };
        case 'media':
            return {
                recipient: { id: recipientId },
                ...messaging,
                message: {
                    attachment: {
                        type: payload.mediaKind === 'document' ? 'file' : payload.mediaKind,
                        payload: { attachment_id: ctx.attachmentId },
                    },
                },
            };
        case 'quick_replies':
            return {
                recipient: { id: recipientId },
                ...messaging,
                message: {
                    text: payload.text,
                    quick_replies: payload.replies.map((r) => ({ content_type: 'text', title: r.title, payload: r.payload })),
                },
            };
        case 'buttons':
            return {
                recipient: { id: recipientId },
                ...messaging,
                message: {
                    attachment: {
                        type: 'template',
                        payload: {
                            template_type: 'button',
                            text: payload.text,
                            buttons: payload.buttons.map((b) => ({ type: 'postback', title: b.title, payload: b.id })),
                        },
                    },
                },
            };
        case 'private_reply':
            return { recipient: { comment_id: payload.commentId }, message: { text: payload.text } };
        case 'reaction':
            return {
                recipient: { id: recipientId },
                sender_action: 'react',
                payload: { message_id: payload.targetExternalId, reaction: payload.emoji },
            };
        default:
            throw new Error(`${payload.type} cannot be sent on Messenger or Instagram`);
    }
}

/** The text a stored outbound row shows, for previews and search. */
export function outboundText(payload: OutboundPayload): string | null {
    switch (payload.type) {
        case 'text':
        case 'buttons':
        case 'list':
        case 'quick_replies':
        case 'private_reply':
            return payload.text;
        case 'media':
            return payload.caption ?? null;
        case 'template':
            return `Template: ${payload.name}`;
        case 'location':
            return payload.name ?? payload.address ?? `${payload.latitude}, ${payload.longitude}`;
        case 'reaction':
            return payload.emoji;
    }
}
