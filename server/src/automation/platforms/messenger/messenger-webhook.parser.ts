/**
 * Pure translation of a Messenger Platform webhook delivery — `object: "page"`
 * (Facebook Messenger) or `object: "instagram"` (Instagram messaging, which is
 * served by the same platform) — into typed events. No DB, no side effects;
 * specced against test/fixtures/meta/fb-*.json and ig-*.json.
 *
 * Events that arrive under `standby[]` (another app, Meta Business Suite or
 * Meta AI owns the thread) are parsed the same way and flagged `standby`: they
 * belong in the inbox, but nothing may reply to them automatically.
 */

export type MessengerPlatform = 'FACEBOOK' | 'INSTAGRAM';

export interface MsAttachment {
    /** image | video | audio | file | sticker | story_mention | ig_reel | ig_post | share | fallback ... */
    type: string;
    url: string | null;
    title: string | null;
}

interface Base {
    platform: MessengerPlatform;
    /** entry.id — the Page id or the Instagram professional account id. */
    accountId: string;
    /** Our app does not own the thread; do not auto-reply. */
    standby: boolean;
    timestamp: Date;
}

export interface MsMessage {
    mid: string;
    text: string | null;
    attachments: MsAttachment[];
    quickReplyPayload: string | null;
    /** The message this one replies to. */
    replyToMid: string | null;
    /** Instagram story the customer replied to. */
    replyToStory: { id: string | null; url: string | null } | null;
    referral: Record<string, unknown> | null;
    isDeleted: boolean;
    isUnsupported: boolean;
    raw: Record<string, unknown>;
}

export type MsEvent =
    | (Base & { kind: 'message'; senderId: string; message: MsMessage })
    | (Base & {
        kind: 'echo';
        /** The customer the business wrote to. */
        recipientId: string;
        /** Which app sent it: ours, the Page inbox, another tool. */
        appId: string | null;
        metadata: string | null;
        message: MsMessage;
    })
    | (Base & { kind: 'postback'; senderId: string; mid: string | null; title: string | null; payload: string | null; referral: Record<string, unknown> | null })
    | (Base & { kind: 'delivery'; senderId: string; mids: string[]; watermark: Date | null })
    | (Base & { kind: 'read'; senderId: string; watermark: Date | null; mid: string | null })
    | (Base & { kind: 'reaction'; senderId: string; mid: string; emoji: string | null; action: 'react' | 'unreact' })
    | (Base & { kind: 'edit'; senderId: string; mid: string; text: string | null })
    | (Base & { kind: 'referral'; senderId: string; referral: Record<string, unknown> })
    | (Base & { kind: 'handover'; senderId: string; type: string; value: Record<string, unknown> })
    | (Base & {
        kind: 'comment';
        commentId: string;
        /** Facebook post id or Instagram media id the comment is on. */
        postId: string | null;
        parentId: string | null;
        text: string | null;
        fromId: string | null;
        fromName: string | null;
        /** add | edited | remove (Facebook); Instagram comments are always new. */
        verb: string;
        mediaProductType: string | null;
        raw: Record<string, unknown>;
    })
    | (Base & { kind: 'mention'; commentId: string | null; mediaId: string | null; raw: Record<string, unknown> })
    | (Base & { kind: 'other'; type: string; raw: Record<string, unknown> });

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function arr(v: unknown): Obj[] {
    return Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : [];
}

function str(v: unknown): string | null {
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
}

/**
 * Messaging timestamps are milliseconds; the occasional string is seconds
 * (the postback reference example). Anything below 1e12 is taken as seconds.
 */
function time(v: unknown): Date | null {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return null;
    return new Date(n < 1e12 ? n * 1000 : n);
}

function toMessage(m: Obj): MsMessage | null {
    const mid = str(m.mid);
    if (!mid) return null;
    const replyTo = obj(m.reply_to);
    const story = obj(replyTo?.story);
    return {
        mid,
        text: str(m.text),
        attachments: arr(m.attachments).map((a) => {
            const payload = obj(a.payload);
            return {
                type: str(a.type) ?? 'unknown',
                url: str(payload?.url),
                title: str(payload?.title) ?? str(a.title),
            };
        }),
        quickReplyPayload: str(obj(m.quick_reply)?.payload),
        replyToMid: str(replyTo?.mid),
        replyToStory: story ? { id: str(story.id), url: str(story.url) } : null,
        referral: obj(m.referral),
        isDeleted: m.is_deleted === true,
        isUnsupported: m.is_unsupported === true,
        raw: m,
    };
}

function parseMessaging(
    ev: Obj,
    platform: MessengerPlatform,
    accountId: string,
    standby: boolean,
    fallback: Date,
): MsEvent | null {
    const base = { platform, accountId, standby, timestamp: time(ev.timestamp) ?? fallback };
    const senderId = str(obj(ev.sender)?.id);
    const recipientId = str(obj(ev.recipient)?.id);

    const message = obj(ev.message);
    if (message) {
        const parsed = toMessage(message);
        if (!parsed) return { ...base, kind: 'other', type: 'message_without_mid', raw: ev };
        if (message.is_echo === true) {
            if (!recipientId) return null;
            return {
                ...base,
                kind: 'echo',
                recipientId,
                appId: str(message.app_id),
                metadata: str(message.metadata),
                message: parsed,
            };
        }
        if (!senderId) return null;
        return { ...base, kind: 'message', senderId, message: parsed };
    }

    if (!senderId) return { ...base, kind: 'other', type: 'no_sender', raw: ev };

    const postback = obj(ev.postback);
    if (postback) {
        return {
            ...base,
            kind: 'postback',
            senderId,
            mid: str(postback.mid),
            title: str(postback.title),
            payload: str(postback.payload),
            referral: obj(postback.referral),
        };
    }
    const delivery = obj(ev.delivery);
    if (delivery) {
        return {
            ...base,
            kind: 'delivery',
            senderId,
            mids: Array.isArray(delivery.mids) ? delivery.mids.map(str).filter((x): x is string => !!x) : [],
            watermark: time(delivery.watermark),
        };
    }
    const read = obj(ev.read);
    if (read) {
        return { ...base, kind: 'read', senderId, watermark: time(read.watermark), mid: str(read.mid) };
    }
    const reaction = obj(ev.reaction);
    const reactedMid = str(reaction?.mid);
    if (reaction && reactedMid) {
        return {
            ...base,
            kind: 'reaction',
            senderId,
            mid: reactedMid,
            emoji: str(reaction.emoji),
            action: reaction.action === 'unreact' ? 'unreact' : 'react',
        };
    }
    const edit = obj(ev.message_edit);
    const editedMid = str(edit?.mid);
    if (edit && editedMid) {
        return { ...base, kind: 'edit', senderId, mid: editedMid, text: str(edit.text) };
    }
    const referral = obj(ev.referral);
    if (referral) return { ...base, kind: 'referral', senderId, referral };

    for (const type of ['pass_thread_control', 'take_thread_control', 'request_thread_control', 'app_roles']) {
        const value = obj(ev[type]);
        if (value) return { ...base, kind: 'handover', senderId, type, value };
    }
    const keys = Object.keys(ev).filter((k) => !['sender', 'recipient', 'timestamp'].includes(k));
    return { ...base, kind: 'other', type: keys.join(',') || 'empty', raw: ev };
}

function parseChange(
    field: string,
    value: Obj,
    platform: MessengerPlatform,
    accountId: string,
    fallback: Date,
): MsEvent | null {
    const base = { platform, accountId, standby: false, timestamp: fallback };

    // Facebook Page feed: comments on the Page's posts.
    if (platform === 'FACEBOOK' && field === 'feed') {
        if (str(value.item) !== 'comment') {
            return { ...base, kind: 'other', type: `feed:${str(value.item) ?? 'unknown'}`, raw: value };
        }
        const commentId = str(value.comment_id);
        if (!commentId) return null;
        const from = obj(value.from);
        return {
            ...base,
            timestamp: time(value.created_time) ?? fallback,
            kind: 'comment',
            commentId,
            postId: str(value.post_id),
            parentId: str(value.parent_id),
            text: str(value.message),
            fromId: str(from?.id),
            fromName: str(from?.name),
            verb: str(value.verb) ?? 'add',
            mediaProductType: null,
            raw: value,
        };
    }

    // Instagram: comments / live comments on the account's media.
    if (platform === 'INSTAGRAM' && (field === 'comments' || field === 'live_comments')) {
        // Instagram Login sends the comment id as `id`, Facebook Login as `comment_id`.
        const commentId = str(value.comment_id) ?? str(value.id);
        if (!commentId) return null;
        const from = obj(value.from);
        const media = obj(value.media);
        return {
            ...base,
            kind: 'comment',
            commentId,
            postId: str(media?.id),
            parentId: str(value.parent_id),
            text: str(value.text),
            fromId: str(from?.id),
            fromName: str(from?.username),
            verb: 'add',
            mediaProductType: str(media?.media_product_type),
            raw: value,
        };
    }
    if (platform === 'INSTAGRAM' && field === 'mentions') {
        return { ...base, kind: 'mention', commentId: str(value.comment_id), mediaId: str(value.media_id), raw: value };
    }

    // The dashboard's Test button and some Instagram Login deliveries wrap a
    // messaging event as a change.
    if (obj(value.sender) || obj(value.recipient)) {
        return parseMessaging(value, platform, accountId, false, fallback);
    }
    return { ...base, kind: 'other', type: field, raw: value };
}

/** Every event in one `page` or `instagram` delivery, in payload order. */
export function parseMessengerDelivery(body: unknown): MsEvent[] {
    const root = obj(body);
    const platform: MessengerPlatform | null =
        root?.object === 'page' ? 'FACEBOOK' : root?.object === 'instagram' ? 'INSTAGRAM' : null;
    if (!root || !platform) return [];

    const events: MsEvent[] = [];
    for (const entry of arr(root.entry)) {
        const accountId = str(entry.id);
        if (!accountId) continue;
        const fallback = time(entry.time) ?? new Date();
        for (const ev of arr(entry.messaging)) {
            const parsed = parseMessaging(ev, platform, accountId, false, fallback);
            if (parsed) events.push(parsed);
        }
        for (const ev of arr(entry.standby)) {
            const parsed = parseMessaging(ev, platform, accountId, true, fallback);
            if (parsed) events.push(parsed);
        }
        for (const change of arr(entry.changes)) {
            const field = str(change.field);
            const value = obj(change.value);
            if (!field || !value) continue;
            const parsed = parseChange(field, value, platform, accountId, fallback);
            if (parsed) events.push(parsed);
        }
    }
    return events;
}
