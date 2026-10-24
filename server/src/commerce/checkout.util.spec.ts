import { parseCheckout } from './checkout.util';

describe('parseCheckout', () => {
    it('reads what recovery needs from a checkouts/update body', () => {
        const c = parseCheckout({
            id: 35168481427622,
            token: 'b1946ac92492d2347c6235b4d2611184',
            abandoned_checkout_url: 'https://acme.example/12345/checkouts/b19/recover?key=abc',
            phone: null,
            email: 'riya@example.com',
            completed_at: null,
            presentment_currency: 'INR',
            currency: 'INR',
            total_price: '2398.00',
            shipping_address: { phone: '+91 98000 00011', first_name: 'Riya' },
            customer: { id: 9071, first_name: 'Riya', phone: '+919800000099' },
            line_items: [{ variant_id: 444, product_id: 33, title: 'Linen shirt', quantity: 2, price: '1199.00' }],
        });
        expect(c).toMatchObject({
            externalId: '35168481427622',
            recoveryUrl: 'https://acme.example/12345/checkouts/b19/recover?key=abc',
            phone: '+919800000011',
            firstName: 'Riya',
            customerExternalId: '9071',
            completedAt: null,
            currency: 'INR',
            total: 2398,
            items: [{ variantId: '444', productId: '33', title: 'Linen shirt', quantity: 2, price: 1199 }],
        });
    });

    it('reads a number typed without its country code by the address country', () => {
        const typed = (phone: string, address: Record<string, unknown> = { country_code: 'IN' }) =>
            parseCheckout({ id: 1, shipping_address: { phone, ...address } })?.phone;
        expect(typed('98765 43210')).toBe('+919876543210');
        expect(typed('098765 43210')).toBe('+919876543210');
        expect(parseCheckout({ id: 1, billing_address: { phone: '9876543210', country_code: 'in' } })?.phone).toBe('+919876543210');
        expect(parseCheckout({ id: 1, phone: '9876543210', customer: { default_address: { country_code: 'IN' } } })?.phone).toBe('+919876543210');
        // Without a country it stays as typed.
        expect(typed('98765 43210', {})).toBe('98765 43210');
    });

    it('marks completed checkouts and ignores bodies without an id', () => {
        expect(parseCheckout({ id: 1, completed_at: '2026-10-23T10:00:00Z' })?.completedAt?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
        expect(parseCheckout({ token: 'x' })).toBeNull();
    });
});
