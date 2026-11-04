import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta's `signed_request`, the form field it POSTs to an app's Deauthorize and
 * Data deletion callbacks: `<signature>.<payload>`, both base64url, where the
 * signature is HMAC-SHA256 of the encoded payload under the app secret.
 *
 * Kept free of Nest so the signature check, the only thing standing between a
 * public URL and disconnecting someone's account, can be tested directly.
 */
export interface MetaSignedRequest {
    /** The app-scoped id of the person who removed the app. */
    userId: string;
    issuedAt: number | null;
}

/**
 * The payload, or null when it is malformed or signed by none of `secrets`.
 * Several secrets because Instagram Login signs with the Instagram app secret
 * and Facebook Login with the Meta app secret; empty ones are skipped.
 */
export function parseMetaSignedRequest(
    signedRequest: unknown,
    secrets: ReadonlyArray<string | null | undefined>,
): MetaSignedRequest | null {
    if (typeof signedRequest !== 'string') return null;
    const [encodedSig, encodedPayload, ...rest] = signedRequest.split('.');
    if (!encodedSig || !encodedPayload || rest.length > 0) return null;

    const sig = Buffer.from(encodedSig, 'base64url');
    const signedBy = secrets.some((secret) => {
        if (!secret) return false;
        const expected = createHmac('sha256', secret).update(encodedPayload).digest();
        return expected.length === sig.length && timingSafeEqual(expected, sig);
    });
    if (!signedBy) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const payload = parsed as Record<string, unknown>;
    if (typeof payload.algorithm === 'string' && payload.algorithm.toUpperCase() !== 'HMAC-SHA256') return null;

    // A number past 2^53 would already have lost digits in JSON.parse, so
    // only a string id, or a number that is still exact, is trusted.
    const rawId = payload.user_id;
    const userId =
        typeof rawId === 'string' && /^\d+$/.test(rawId)
            ? rawId
            : typeof rawId === 'number' && Number.isSafeInteger(rawId)
              ? String(rawId)
              : null;
    if (!userId) return null;

    return {
        userId,
        issuedAt: typeof payload.issued_at === 'number' ? payload.issued_at : null,
    };
}
