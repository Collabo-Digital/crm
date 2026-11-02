import { readStoreLinkToken, storeLinkKey, storeLinkPrefix, storeLinkToken } from './store-links';

describe('store links', () => {
    const key = storeLinkKey('test-secret');
    const id = 'cm3x8k2p40000qz7w1rbt9e4d';

    it('reads back the id it was made for', () => {
        expect(readStoreLinkToken(key, 'order', storeLinkToken(key, 'order', id))).toBe(id);
        expect(readStoreLinkToken(key, 'cart', storeLinkToken(key, 'cart', id))).toBe(id);
    });

    it('refuses a token of the other kind, another key, or any change', () => {
        const token = storeLinkToken(key, 'order', id);
        expect(readStoreLinkToken(key, 'cart', token)).toBeNull();
        expect(readStoreLinkToken(storeLinkKey('other'), 'order', token)).toBeNull();
        for (let i = 0; i < token.length; i++) {
            const changed = token.slice(0, i) + (token[i] === 'a' ? 'b' : 'a') + token.slice(i + 1);
            expect(readStoreLinkToken(key, 'order', changed)).toBeNull();
        }
        for (const bad of [null, undefined, '', id, `${token}.x`, `../${token}`, 'x'.repeat(200)]) {
            expect(readStoreLinkToken(key, 'order', bad)).toBeNull();
        }
    });

    it('builds the button prefix on the app address', () => {
        expect(storeLinkPrefix('https://app.example.com/', 'order')).toBe('https://app.example.com/t/');
        expect(storeLinkPrefix('https://app.example.com', 'cart')).toBe('https://app.example.com/c/');
    });
});
