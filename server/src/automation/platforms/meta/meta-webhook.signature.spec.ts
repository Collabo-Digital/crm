import { createHmac } from 'crypto';
import { bodyHash, matchMetaSignature, summariseDelivery } from './meta-webhook.signature';

const sign = (body: Buffer, secret: string) =>
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('matchMetaSignature', () => {
    const body = Buffer.from('{"object":"page","entry":[{"id":"1","messaging":[]}]}');
    const secrets = [
        { label: 'INSTAGRAM_APP_SECRET', secret: 'ig-secret' },
        { label: 'META_APP_SECRET', secret: 'app-secret' },
    ];

    it('names the secret that signed the body', () => {
        expect(matchMetaSignature(body, sign(body, 'app-secret'), secrets)).toBe('META_APP_SECRET');
        expect(matchMetaSignature(body, sign(body, 'ig-secret'), secrets)).toBe('INSTAGRAM_APP_SECRET');
    });

    it('refuses a missing, foreign or tampered signature', () => {
        expect(matchMetaSignature(body, undefined, secrets)).toBeNull();
        expect(matchMetaSignature(body, sign(body, 'someone-else'), secrets)).toBeNull();
        const tampered = Buffer.from(body.toString().replace('"1"', '"2"'));
        expect(matchMetaSignature(tampered, sign(body, 'app-secret'), secrets)).toBeNull();
        expect(matchMetaSignature(body, 'sha256=short', secrets)).toBeNull();
    });

    it('checks the raw bytes, so escaped unicode must not be re-serialised', () => {
        const escaped = Buffer.from('{"text":"\\u00e9"}');
        const header = sign(escaped, 'app-secret');
        const reserialised = Buffer.from(JSON.stringify(JSON.parse(escaped.toString())));
        expect(matchMetaSignature(escaped, header, secrets)).toBe('META_APP_SECRET');
        expect(matchMetaSignature(reserialised, header, secrets)).toBeNull();
    });
});

describe('bodyHash', () => {
    it('is stable for identical bodies and differs otherwise', () => {
        expect(bodyHash(Buffer.from('a'))).toBe(bodyHash(Buffer.from('a')));
        expect(bodyHash(Buffer.from('a'))).not.toBe(bodyHash(Buffer.from('b')));
    });
});

describe('summariseDelivery', () => {
    it('collects entry ids and field names across shapes', () => {
        expect(
            summariseDelivery({
                entry: [
                    { id: '102290129340398', changes: [{ field: 'messages' }, { field: 'history' }] },
                    { id: 682498302938465, messaging: [], standby: [] },
                ],
            }),
        ).toEqual({
            entryIds: ['102290129340398', '682498302938465'],
            fields: ['messages', 'history', 'messaging', 'standby'],
        });
        expect(summariseDelivery({})).toEqual({ entryIds: [], fields: [] });
    });
});
