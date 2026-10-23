import { MEDIA_URL_TTL_S, signMediaPath, verifyMediaSignature } from './media-url';

describe('signed media links', () => {
    const secret = 'test-secret';
    const now = Date.UTC(2026, 9, 23, 12, 0, 0);

    function parts(path: string) {
        const url = new URL(path, 'http://x');
        return { id: decodeURIComponent(url.pathname.split('/').pop()!), exp: url.searchParams.get('exp')!, sig: url.searchParams.get('sig')! };
    }

    it('verifies its own link until it expires', () => {
        const { id, exp, sig } = parts(signMediaPath(secret, 'msg_1', now));
        expect(id).toBe('msg_1');
        expect(verifyMediaSignature(secret, 'msg_1', exp, sig, now)).toBe(true);
        expect(verifyMediaSignature(secret, 'msg_1', exp, sig, now + (MEDIA_URL_TTL_S + 1) * 1000)).toBe(false);
    });

    it('refuses another message, a changed expiry, another secret or a missing signature', () => {
        const { exp, sig } = parts(signMediaPath(secret, 'msg_1', now));
        expect(verifyMediaSignature(secret, 'msg_2', exp, sig, now)).toBe(false);
        expect(verifyMediaSignature(secret, 'msg_1', String(Number(exp) + 3600), sig, now)).toBe(false);
        expect(verifyMediaSignature('other', 'msg_1', exp, sig, now)).toBe(false);
        expect(verifyMediaSignature(secret, 'msg_1', exp, undefined, now)).toBe(false);
        expect(verifyMediaSignature(secret, 'msg_1', 'soon', sig, now)).toBe(false);
    });
});
