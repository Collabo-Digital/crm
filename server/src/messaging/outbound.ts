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
        /** A header file to upload at send time; its media id becomes the header parameter. */
        headerMedia?: { storageKey: string; mime: string; kind: 'image' | 'video' | 'document'; filename?: string };
        /** The body as this person reads it, for the thread and search. Never sent to Meta. */
        previewText?: string;
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
    | { type: 'private_reply'; commentId: string; text: string }
    /** A public reply under an Instagram or Facebook comment. */
    | { type: 'comment_reply'; commentId: string; text: string }
    /** WhatsApp: one product from the number's catalog. `name` is for the thread only. */
    | { type: 'product'; catalogId: string; productRetailerId: string; text?: string; footer?: string; name?: string }
    /** WhatsApp: up to 30 products in sections, with a text header. */
    | {
        type: 'product_list';
        catalogId: string;
        header: string;
        text: string;
        footer?: string;
        sections: Array<{ title: string; productRetailerIds: string[] }>;
    }
    /** WhatsApp: 2 to 10 product cards to swipe through, all from one catalog. */
    | { type: 'product_carousel'; catalogId: string; text: string; productRetailerIds: string[] }
    /** WhatsApp: asks the person to allow calls from the business; only the text can be set. */
    | { type: 'call_permission_request'; text: string }
    /** WhatsApp: a button that opens the whole catalog. */
    | { type: 'catalog'; text: string; footer?: string; thumbnailRetailerId?: string }
    /**
     * WhatsApp Pay (India): the "Review and Pay" bill. `parameters` is Meta's
     * `action.parameters` (reference_id, order, payment_settings…); `summary`
     * is for the thread only.
     */
    | { type: 'order_details'; text: string; footer?: string; parameters: Record<string, unknown>; summary: string }
    /** WhatsApp Pay: an update to that order's status on the customer's order page. */
    | { type: 'order_status'; text: string; referenceId: string; status: 'processing' | 'shipped' | 'completed' | 'canceled'; description?: string };

export type SendOrigin = 'agent' | 'automation' | 'broadcast' | 'system' | 'api';

export interface GateInput {
    platform: ChannelPlatform;
    payload: OutboundPayload;
    origin: SendOrigin;
    /** onBusinessApp: a coexistence number, which cannot send catalog messages through the API. */
    channel: { status: ChannelStatus; isEnabled: boolean; sendsPaused: boolean; onBusinessApp?: boolean };
    contact: { blockedAt: Date | null; optedOutAt: Date | null };
    /** A WhatsApp group's chat; `closed` says why it cannot be messaged, if it cannot. */
    group?: { closed: string | null } | null;
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
    if (input.group) {
        if (input.group.closed) return refuse('channel_unavailable', input.group.closed);
        // Meta: groups take text, media and templates; no interactive, commerce or reaction messages.
        if (!['text', 'media', 'template'].includes(payload.type)) {
            return refuse('unsupported_on_platform', 'WhatsApp groups take text, files and templates only.');
        }
    }

    const shape = checkShape(platform, payload);
    if (shape) return shape;
    if (channel.onBusinessApp && (payload.type === 'product' || payload.type === 'product_list' || payload.type === 'product_carousel' || payload.type === 'catalog')) {
        return refuse('unsupported_on_platform', 'Products cannot be sent from a number shared with the WhatsApp Business app. Share a link instead.');
    }
    if (channel.onBusinessApp && payload.type === 'call_permission_request') {
        return refuse('unsupported_on_platform', 'Calls are not available on a number shared with the WhatsApp Business app.');
    }

    if (payload.type === 'template') {
        if (payload.category === 'MARKETING' && contact.optedOutAt) {
            return refuse('opted_out', 'This customer opted out of marketing messages.');
        }
        return { ok: true, humanAgentTag: false };
    }
    if (payload.type === 'private_reply' || payload.type === 'comment_reply' || payload.type === 'reaction') {
        // Private replies have their own 7-day rule, enforced by Meta per comment;
        // a public reply is a comment, not a message, and has no window at all.
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
        case 'location':
            return wa ? null : refuse('unsupported_on_platform', 'This message type is only available on WhatsApp.');
        case 'list': {
            if (!wa) return refuse('unsupported_on_platform', 'This message type is only available on WhatsApp.');
            // Meta: at most 10 rows across all sections, ids unique, a title on every section when there are several.
            const rows = payload.sections.flatMap((sec) => sec.rows);
            if (!payload.text.trim() || payload.text.length > 4096) return refuse('invalid_payload', 'Write a message of up to 4,096 characters.');
            if (!payload.buttonText.trim() || payload.buttonText.length > 20) return refuse('invalid_payload', 'The list button label can be at most 20 characters.');
            if (rows.length < 1 || rows.length > 10) return refuse('invalid_payload', 'A list takes 1 to 10 options in all.');
            if (rows.some((r) => !r.title.trim() || r.title.length > 24)) return refuse('invalid_payload', 'List options need a title of up to 24 characters.');
            if (new Set(rows.map((r) => r.id)).size !== rows.length) return refuse('invalid_payload', 'Each list option needs its own id.');
            if (payload.sections.length > 1 && payload.sections.some((sec) => !sec.title?.trim())) {
                return refuse('invalid_payload', 'Give every section a title when the list has more than one.');
            }
            return null;
        }
        case 'buttons': {
            if (payload.buttons.length < 1 || payload.buttons.length > 3) {
                return refuse('invalid_payload', 'Use one to three buttons.');
            }
            if (payload.buttons.some((b) => !b.title.trim() || b.title.length > 20)) {
                return refuse('invalid_payload', 'Button labels need 1 to 20 characters.');
            }
            // WhatsApp refuses two buttons with the same label (error 131009).
            const labels = payload.buttons.map((b) => b.title.trim().toLowerCase());
            if (new Set(labels).size !== labels.length) return refuse('invalid_payload', 'Give each button a different label.');
            if (new Set(payload.buttons.map((b) => b.id)).size !== payload.buttons.length) {
                return refuse('invalid_payload', 'Each button needs its own id.');
            }
            if (!payload.text.trim()) return refuse('invalid_payload', 'Write a message first.');
            if (payload.text.length > (wa ? 1024 : 640)) {
                return refuse('invalid_payload', `A message with buttons can be at most ${wa ? '1,024' : '640'} characters.`);
            }
            return null;
        }
        case 'quick_replies':
            if (wa) return refuse('unsupported_on_platform', 'Use buttons or a list on WhatsApp.');
            if (payload.replies.length < 1 || payload.replies.length > 13) {
                return refuse('invalid_payload', 'Use one to thirteen quick replies.');
            }
            return null;
        case 'private_reply':
        case 'comment_reply':
            return wa ? refuse('unsupported_on_platform', 'Comment replies are for Instagram and Facebook comments.') : null;
        case 'product':
            return wa ? null : refuse('unsupported_on_platform', 'Products from the catalog can be sent on WhatsApp only.');
        case 'product_list': {
            if (!wa) return refuse('unsupported_on_platform', 'Products from the catalog can be sent on WhatsApp only.');
            const count = payload.sections.reduce((n, sec) => n + sec.productRetailerIds.length, 0);
            if (count < 1 || count > 30) return refuse('invalid_payload', 'Choose between 1 and 30 products.');
            if (!payload.header.trim() || !payload.text.trim()) return refuse('invalid_payload', 'A product list needs a header and a message.');
            return null;
        }
        case 'call_permission_request':
            if (!wa) return refuse('unsupported_on_platform', 'Calls are on WhatsApp only.');
            if (!payload.text.trim() || payload.text.length > 1024) return refuse('invalid_payload', 'Write a message of up to 1,024 characters.');
            return null;
        case 'product_carousel':
            if (!wa) return refuse('unsupported_on_platform', 'Products from the catalog can be sent on WhatsApp only.');
            if (payload.productRetailerIds.length < 2 || payload.productRetailerIds.length > 10) return refuse('invalid_payload', 'Product cards take 2 to 10 products.');
            if (!payload.text.trim() || payload.text.length > 1024) return refuse('invalid_payload', 'Write a message of up to 1,024 characters.');
            return null;
        case 'order_details':
        case 'order_status':
            if (!wa) return refuse('unsupported_on_platform', 'WhatsApp Pay requests go on WhatsApp only.');
            if (!payload.text.trim() || payload.text.length > 1024) return refuse('invalid_payload', 'Write a message of up to 1,024 characters.');
            return null;
        case 'catalog':
            if (!wa) return refuse('unsupported_on_platform', 'The catalog can be sent on WhatsApp only.');
            if (!payload.text.trim() || payload.text.length > 1024) return refuse('invalid_payload', 'Write a message of up to 1,024 characters.');
            return null;
        default:
            return null;
    }
}

/** Where a WhatsApp message goes: the phone number when we have it, else the BSUID. */
export interface WhatsAppRecipient {
    waId: string | null;
    userId: string | null;
    /** A WhatsApp group: the message goes to the group, not a person. */
    groupId?: string | null;
}

/** The body for POST /{phone_number_id}/messages. */
export function buildWhatsAppBody(
    payload: OutboundPayload,
    recipient: WhatsAppRecipient,
    ctx: { replyToExternalId?: string | null; mediaId?: string | null } = {},
): Record<string, unknown> {
    // Meta: when both are sent, `to` wins; phone numbers also keep phone
    // numbers flowing in later webhooks.
    const address = recipient.groupId
        ? { recipient_type: 'group', to: recipient.groupId }
        : { recipient_type: 'individual', ...(recipient.waId ? { to: recipient.waId } : { recipient: recipient.userId }) };
    const base = {
        messaging_product: 'whatsapp',
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
        case 'product':
            return {
                ...base,
                type: 'interactive',
                interactive: {
                    type: 'product',
                    ...(payload.text ? { body: { text: payload.text } } : {}),
                    ...(payload.footer ? { footer: { text: payload.footer } } : {}),
                    action: { catalog_id: payload.catalogId, product_retailer_id: payload.productRetailerId },
                },
            };
        case 'product_list':
            return {
                ...base,
                type: 'interactive',
                interactive: {
                    type: 'product_list',
                    header: { type: 'text', text: payload.header },
                    body: { text: payload.text },
                    ...(payload.footer ? { footer: { text: payload.footer } } : {}),
                    action: {
                        catalog_id: payload.catalogId,
                        sections: payload.sections.map((sec) => ({
                            title: sec.title,
                            product_items: sec.productRetailerIds.map((id) => ({ product_retailer_id: id })),
                        })),
                    },
                },
            };
        case 'call_permission_request':
            return {
                ...base,
                type: 'interactive',
                interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' }, body: { text: payload.text } },
            };
        case 'product_carousel':
            return {
                ...base,
                type: 'interactive',
                interactive: {
                    type: 'carousel',
                    body: { text: payload.text },
                    action: {
                        cards: payload.productRetailerIds.map((id, index) => ({
                            card_index: index,
                            type: 'product',
                            action: { product_retailer_id: id, catalog_id: payload.catalogId },
                        })),
                    },
                },
            };
        case 'catalog':
            return {
                ...base,
                type: 'interactive',
                interactive: {
                    type: 'catalog_message',
                    body: { text: payload.text },
                    ...(payload.footer ? { footer: { text: payload.footer } } : {}),
                    action: {
                        name: 'catalog_message',
                        ...(payload.thumbnailRetailerId ? { parameters: { thumbnail_product_retailer_id: payload.thumbnailRetailerId } } : {}),
                    },
                },
            };
        case 'order_details':
            return {
                ...base,
                type: 'interactive',
                interactive: {
                    type: 'order_details',
                    body: { text: payload.text },
                    ...(payload.footer ? { footer: { text: payload.footer } } : {}),
                    action: { name: 'review_and_pay', parameters: payload.parameters },
                },
            };
        case 'order_status':
            return {
                ...base,
                type: 'interactive',
                interactive: {
                    type: 'order_status',
                    body: { text: payload.text },
                    action: {
                        name: 'review_order',
                        parameters: {
                            reference_id: payload.referenceId,
                            order: { status: payload.status, ...(payload.description ? { description: payload.description.slice(0, 120) } : {}) },
                        },
                    },
                },
            };
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
        case 'comment_reply':
            return payload.text;
        case 'media':
            return payload.caption ?? null;
        case 'template':
            return payload.previewText ?? `Template: ${payload.name}`;
        case 'location':
            return payload.name ?? payload.address ?? `${payload.latitude}, ${payload.longitude}`;
        case 'reaction':
            return payload.emoji;
        case 'product':
            return payload.text || (payload.name ? `Product: ${payload.name}` : 'Product');
        case 'product_list':
            return `${payload.header}\n${payload.text}`;
        case 'product_carousel':
        case 'call_permission_request':
            return payload.text;
        case 'catalog':
            return payload.text;
        case 'order_details':
            return payload.summary;
        case 'order_status':
            return payload.text;
    }
}
