import { createHash, createHmac, timingSafeEqual } from 'crypto';

export interface SigningSecret {
    /** For log lines only: which configured secret matched. */
    label: string;
    secret: string;
}

/**
 * Which secret produced Meta's `X-Hub-Signature-256` header, or null for none.
 *
 * The HMAC is over the raw request bytes. Messenger documents that it signs
 * the escaped-unicode payload, so re-serialising the parsed JSON would not
 * match — only `req.rawBody` is valid input.
 */
export function matchMetaSignature(
    rawBody: Buffer,
    header: string | undefined,
    secrets: SigningSecret[],
): string | null {
    if (!header) return null;
    const received = Buffer.from(header);
    for (const { label, secret } of secrets) {
        const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
        if (received.length === expected.length && timingSafeEqual(received, expected)) return label;
    }
    return null;
}

/** The redelivery key: Meta resends byte-identical bodies. */
export function bodyHash(rawBody: Buffer): string {
    return createHash('sha256').update(rawBody).digest('hex');
}

/** entry ids and field names, stored beside the payload for routing and debugging. */
export function summariseDelivery(body: { entry?: unknown }): { entryIds: string[]; fields: string[] } {
    const entryIds = new Set<string>();
    const fields = new Set<string>();
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const raw of entries) {
        const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        if (typeof entry.id === 'string' || typeof entry.id === 'number') entryIds.add(String(entry.id));
        if (Array.isArray(entry.messaging)) fields.add('messaging');
        if (Array.isArray(entry.standby)) fields.add('standby');
        for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
            const field = change && typeof change === 'object' ? (change as { field?: unknown }).field : undefined;
            if (typeof field === 'string') fields.add(field);
        }
    }
    return { entryIds: [...entryIds], fields: [...fields] };
}
