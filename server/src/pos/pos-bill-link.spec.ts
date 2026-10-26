import { billLinkKey, billToken, maskPhone, readBillToken } from './pos-bill-link';

/** The public bill link: only the bill it was made for, and nothing a stranger can make or change. */

const KEY = billLinkKey('k'.repeat(32));
const ORDER = 'cmh3x8k2p40000qz7w1rbt9e4d';

describe('bill link tokens', () => {
    it('round-trips to the order it was made for, and is URL-safe', () => {
        const token = billToken(KEY, ORDER);
        expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(readBillToken(KEY, token)).toBe(ORDER);
    });

    it('names no organization, customer or order number', () => {
        const [id, sig] = billToken(KEY, ORDER).split('.');
        expect(id).toBe(ORDER);
        expect(sig).toHaveLength(22);
    });

    it('refuses every change to the signature, a moved signature, and another key', () => {
        const token = billToken(KEY, ORDER);
        const [id, sig] = token.split('.');
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        for (let i = 0; i < sig.length; i++) {
            for (const c of [alphabet[(alphabet.indexOf(sig[i]) + 1) % 64], alphabet[(alphabet.indexOf(sig[i]) + 33) % 64]]) {
                expect(readBillToken(KEY, `${id}.${sig.slice(0, i)}${c}${sig.slice(i + 1)}`)).toBeNull();
            }
        }
        expect(readBillToken(KEY, `${'cmh3x8k2p40000qz7w1rbt9e4e'}.${sig}`)).toBeNull();
        expect(readBillToken(billLinkKey('another secret, 32 characters...'), token)).toBeNull();
    });

    it.each([undefined, null, '', ORDER, `${ORDER}.`, `.${'a'.repeat(22)}`, `${ORDER}.x.y`, `../../etc.${'a'.repeat(22)}`, 'a'.repeat(200)])('refuses %p', (token) => {
        expect(readBillToken(KEY, token as string)).toBeNull();
    });
});

describe('masking the customer’s number on the public bill', () => {
    it.each([
        ['+919800000210', '+91 98••• ••210'],
        ['9800000210', '+91 98••• ••210'],
        ['+16505551234', '+1 65••• ••234'],
        ['+447911123456', '+44 79••• ••456'],
        ['+6591234567', '+65 91•••567'],
        ['12345', '•••••'],
        [null, null],
    ])('%p reads %p', (phone, masked) => {
        expect(maskPhone(phone)).toBe(masked);
    });
});
