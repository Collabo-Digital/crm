import { MessageKind } from '@prisma/client';
import type { WaMessage } from '../automation/platforms/whatsapp/whatsapp-webhook.parser';
import type { MsMessage } from '../automation/platforms/messenger/messenger-webhook.parser';

/** A message's file, as the platform described it. Copied to our storage later. */
export interface MediaSpec {
    /** WhatsApp media id, fetched with the channel token. */
    platformMediaId?: string;
    /** Direct URL: Messenger / Instagram attachments, newer WhatsApp webhooks. */
    url?: string;
    mime?: string;
    sha256?: string;
    filename?: string;
    /** WhatsApp voice note (OGG/Opus recorded in the app). */
    voice?: boolean;
    /** Instagram story mentions: Meta forbids storing the media; keep the URL only. */
    doNotStore?: boolean;
}

export interface MessageContent {
    kind: MessageKind;
    /** Readable text: preview, search and keyword matching. */
    text: string | null;
    media: MediaSpec | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const WA_MEDIA: Record<string, MessageKind> = {
    image: MessageKind.IMAGE,
    video: MessageKind.VIDEO,
    audio: MessageKind.AUDIO,
    document: MessageKind.DOCUMENT,
    sticker: MessageKind.STICKER,
};

/** One WhatsApp message (inbound, echo or history item) as stored content. */
export function whatsAppContent(m: WaMessage): MessageContent {
    const body = obj(m.raw[m.type]);
    const mediaKind = WA_MEDIA[m.type];
    if (mediaKind) {
        return {
            kind: mediaKind,
            text: m.text,
            media: {
                platformMediaId: str(body?.id) ?? undefined,
                url: str(body?.url) ?? undefined,
                mime: str(body?.mime_type) ?? undefined,
                sha256: str(body?.sha256) ?? undefined,
                filename: str(body?.filename) ?? undefined,
                voice: body?.voice === true || undefined,
            },
        };
    }
    switch (m.type) {
        case 'text':
            return { kind: MessageKind.TEXT, text: m.text, media: null };
        case 'interactive': {
            const kind = str(body?.type);
            return {
                kind: kind === 'product' ? MessageKind.PRODUCT : MessageKind.INTERACTIVE,
                text: m.text,
                media: null,
            };
        }
        case 'button':
            return { kind: MessageKind.INTERACTIVE, text: m.text, media: null };
        case 'location':
            return { kind: MessageKind.LOCATION, text: m.text, media: null };
        case 'contacts':
            return { kind: MessageKind.CONTACTS, text: m.text, media: null };
        case 'order':
            return { kind: MessageKind.ORDER, text: m.text, media: null };
        case 'template':
            return { kind: MessageKind.TEMPLATE, text: m.text, media: null };
        case 'system':
            return { kind: MessageKind.SYSTEM, text: m.text, media: null };
        case 'reaction':
            return { kind: MessageKind.REACTION, text: m.text, media: null };
        case 'media_placeholder':
            // History: a media message whose file id arrives in a later delivery.
            return { kind: MessageKind.UNSUPPORTED, text: null, media: {} };
        default:
            return { kind: MessageKind.UNSUPPORTED, text: m.text, media: null };
    }
}

const MS_ATTACHMENT: Record<string, MessageKind> = {
    image: MessageKind.IMAGE,
    video: MessageKind.VIDEO,
    audio: MessageKind.AUDIO,
    file: MessageKind.DOCUMENT,
    sticker: MessageKind.STICKER,
    like_heart: MessageKind.STICKER,
    animated_image_share: MessageKind.IMAGE,
};

/** One Messenger / Instagram message as stored content. */
export function messengerContent(m: MsMessage): MessageContent {
    if (m.isUnsupported) return { kind: MessageKind.UNSUPPORTED, text: m.text, media: null };
    const first = m.attachments[0];
    if (!first) return { kind: MessageKind.TEXT, text: m.text, media: null };

    if (first.type === 'story_mention') {
        return {
            kind: MessageKind.SYSTEM,
            text: m.text ?? 'Mentioned you in their story',
            media: { url: first.url ?? undefined, doNotStore: true },
        };
    }
    const kind = MS_ATTACHMENT[first.type];
    if (kind) return { kind, text: m.text, media: { url: first.url ?? undefined } };
    // Shared posts, reels and anything newer: keep the link, describe it.
    return {
        kind: MessageKind.SYSTEM,
        text: m.text ?? (first.url ? `Shared ${first.type.replace(/_/g, ' ')}: ${first.url}` : `Shared ${first.type}`),
        media: null,
    };
}

const PREVIEW_LENGTH = 140;

const KIND_LABEL: Partial<Record<MessageKind, string>> = {
    [MessageKind.IMAGE]: 'Photo',
    [MessageKind.VIDEO]: 'Video',
    [MessageKind.AUDIO]: 'Audio',
    [MessageKind.DOCUMENT]: 'Document',
    [MessageKind.STICKER]: 'Sticker',
    [MessageKind.LOCATION]: 'Location',
    [MessageKind.CONTACTS]: 'Contact card',
    [MessageKind.ORDER]: 'Cart',
    [MessageKind.PRODUCT]: 'Product',
    [MessageKind.TEMPLATE]: 'Template message',
    [MessageKind.UNSUPPORTED]: 'Message',
    [MessageKind.COMMENT]: 'Comment',
};

/** The one line the conversation list shows for a message. */
export function previewOf(content: Pick<MessageContent, 'kind' | 'text' | 'media'>): string {
    const text = content.text?.replace(/\s+/g, ' ').trim();
    const label = content.media?.voice ? 'Voice message' : KIND_LABEL[content.kind];
    const line = label && text ? `${label}: ${text}` : text || label || '';
    return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1)}…` : line;
}
