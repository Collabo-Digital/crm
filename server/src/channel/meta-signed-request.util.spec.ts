import { createHmac } from 'node:crypto';
import { parseMetaSignedRequest } from './meta-signed-request.util';

const IG_SECRET = 'instagram-app-secret';
const META_SECRET = 'meta-app-secret';

function sign(payload: unknown, secret: string): string {
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const encoded = Buffer.from(json).toString('base64url');
    const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${sig}.${encoded}`;
}

const payload = { algorithm: 'HMAC-SHA256', issued_at: 1793760000, user_id: '27710078791945289' };

describe('parseMetaSignedRequest', () => {
    it('reads the user id from a request signed with the Instagram app secret', () => {
        expect(parseMetaSignedRequest(sign(payload, IG_SECRET), [IG_SECRET, META_SECRET])).toEqual({
            userId: '27710078791945289',
            issuedAt: 1793760000,
        });
    });

    it('also accepts the Meta app secret', () => {
        expect(parseMetaSignedRequest(sign(payload, META_SECRET), [IG_SECRET, META_SECRET])?.userId).toBe(
            '27710078791945289',
        );
    });

    it('rejects a request signed with another secret', () => {
        expect(parseMetaSignedRequest(sign(payload, 'someone-else'), [IG_SECRET, META_SECRET])).toBeNull();
    });

    it('rejects a payload changed after signing', () => {
        const [sig] = sign(payload, IG_SECRET).split('.');
        const forged = Buffer.from(JSON.stringify({ ...payload, user_id: '1' })).toString('base64url');
        expect(parseMetaSignedRequest(`${sig}.${forged}`, [IG_SECRET])).toBeNull();
    });

    it('never matches when no secret is configured', () => {
        expect(parseMetaSignedRequest(sign(payload, ''), ['', undefined, null])).toBeNull();
    });

    it('rejects malformed input', () => {
        for (const input of [undefined, '', 'abc', 'a.b.c', 123]) {
            expect(parseMetaSignedRequest(input, [IG_SECRET])).toBeNull();
        }
    });

    it('rejects another algorithm and a missing user id', () => {
        expect(parseMetaSignedRequest(sign({ ...payload, algorithm: 'HMAC-SHA1' }, IG_SECRET), [IG_SECRET])).toBeNull();
        expect(parseMetaSignedRequest(sign({ algorithm: 'HMAC-SHA256' }, IG_SECRET), [IG_SECRET])).toBeNull();
    });

    it('rejects a numeric id that has already lost precision', () => {
        // Raw JSON: a JS number literal this long would already be rounded.
        const unsafe = '{"algorithm":"HMAC-SHA256","user_id":27710078791945289}';
        expect(parseMetaSignedRequest(sign(unsafe, IG_SECRET), [IG_SECRET])).toBeNull();
        expect(parseMetaSignedRequest(sign({ ...payload, user_id: 12345 }, IG_SECRET), [IG_SECRET])?.userId).toBe('12345');
    });
});
