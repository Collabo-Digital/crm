/**
 * Pure translation of one Instagram webhook entry into typed inbound items.
 * No DB, no side effects. Spec this against the REAL fixtures — the two
 * field paths marked CONFIRM are from Meta's docs, not from a live payload.
 */

export interface InstagramWebhookEntry {
    id: string;
    time?: number; // seconds
    messaging?: Array<{
        sender?: { id?: string };
        recipient?: { id?: string };
        timestamp?: number; // milliseconds
        message?: {
            mid?: string;
            text?: string;
            is_echo?: boolean;
            reply_to?: { story?: unknown };
            attachments?: Array<{ type?: string; payload?: { url?: string } }>;
        };
        postback?: unknown;
        read?: unknown;
        reaction?: unknown;
        referral?: unknown;
    }>;
    changes?: Array<{ field: string; value: Record<string, unknown> }>;
}

export interface InboundComment {
    kind: 'comment';
    externalId: string;
    mediaExternalId: string;
    text: string;
    actorExternalId: string;
    actorUsername?: string;
    parentCommentId?: string;
    occurredAt: Date;
    raw: unknown;
}

export interface InboundDm {
    kind: 'dm';
    externalId: string;
    text?: string;
    actorExternalId: string;
    attachments: Array<{ type?: string; url?: string }>;
    occurredAt: Date;
    raw: unknown;
}

export type InboundItem = InboundComment | InboundDm;

interface CommentValue {
    id?: string;
    text?: string;
    parent_id?: string;
    from?: { id?: string; username?: string };   // CONFIRM against fixture
    media?: { id?: string; media_product_type?: string }; // CONFIRM against fixture
}

export function parseInstagramEntry(
    entry: InstagramWebhookEntry,
    channel: { externalStoreId: string | null },
): InboundItem[] {
    const items: InboundItem[] = [];
    const entryTime = entry.time ? new Date(entry.time * 1000) : new Date();

    for (const change of entry.changes ?? []) {
        if (change.field !== 'comments') continue;
        const v = change.value as CommentValue;
        const actor = v.from?.id;
        const media = v.media?.id;
        if (!v.id || !actor || !media) continue;
        if (channel.externalStoreId && actor === channel.externalStoreId) continue; // merchant's own comment
        items.push({
            kind: 'comment',
            externalId: v.id,
            mediaExternalId: media,
            text: v.text ?? '',
            actorExternalId: actor,
            actorUsername: v.from?.username,
            parentCommentId: v.parent_id,
            occurredAt: entryTime,
            raw: change.value,
        });
    }

    for (const ev of entry.messaging ?? []) {
        const msg = ev.message;
        if (!msg || msg.is_echo) continue; // echoes are our own outbound
        const actor = ev.sender?.id;
        if (!msg.mid || !actor) continue;
        if (channel.externalStoreId && actor === channel.externalStoreId) continue;
        items.push({
            kind: 'dm',
            externalId: msg.mid,
            text: msg.text,
            actorExternalId: actor,
            attachments: (msg.attachments ?? []).map((a) => ({ type: a.type, url: a.payload?.url })),
            occurredAt: ev.timestamp ? new Date(ev.timestamp) : entryTime,
            raw: ev,
        });
    }

    return items;
}