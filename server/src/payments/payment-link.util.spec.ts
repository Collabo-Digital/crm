import { createHmac } from 'node:crypto';
import { linkPath, razorpayContact, razorpaySignatureValid, statusFromRazorpay, toPaise } from './payment-link.util';

describe('payment link helpers', () => {
    it('converts rupees to whole paise without float drift', () => {
        expect(toPaise('2398.00')).toBe(239800);
        expect(toPaise('0.29')).toBe(29);
        expect(toPaise('1199.995')).toBe(120000);
    });

    it('accepts only a signature made with this account’s secret over the exact body', () => {
        const body = Buffer.from('{"event":"payment_link.paid"}');
        const sig = createHmac('sha256', 'secret-a').update(body).digest('hex');
        expect(razorpaySignatureValid(body, sig, 'secret-a')).toBe(true);
        expect(razorpaySignatureValid(body, sig, 'secret-b')).toBe(false);
        expect(razorpaySignatureValid(Buffer.from('{"event":"payment_link.paid" }'), sig, 'secret-a')).toBe(false);
        expect(razorpaySignatureValid(body, 'short', 'secret-a')).toBe(false);
    });

    it('gives the part of the link a template URL button can vary', () => {
        expect(linkPath('https://rzp.io/rzp/aBcD1234')).toBe('rzp/aBcD1234');
        expect(linkPath('https://rzp.io/i/nxrHnLJ')).toBe('i/nxrHnLJ');
        expect(linkPath('not a url')).toBe('');
    });

    it('maps Razorpay’s statuses and ignores unknown ones', () => {
        expect(statusFromRazorpay('paid')).toBe('PAID');
        expect(statusFromRazorpay('partially_paid')).toBe('PARTIALLY_PAID');
        expect(statusFromRazorpay('refunded')).toBeNull();
    });

    it('passes a contact only in the length Razorpay accepts', () => {
        expect(razorpayContact('+919811100081')).toBe('+919811100081');
        expect(razorpayContact('+1234')).toBeUndefined();
        expect(razorpayContact(null)).toBeUndefined();
    });
});
