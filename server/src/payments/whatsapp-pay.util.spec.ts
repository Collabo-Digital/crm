import { buildOrderDetails, configurationActive, indianAddress, type BillInput } from './whatsapp-pay.util';

const address = { name: 'Meera Test', address_line1: '1 MG Road', city: 'Pune', state: 'MH', postal_code: '411001' };
const base = (over: Partial<BillInput> = {}): BillInput => ({
    referenceId: 'cw_abc',
    lines: [{ name: 'Linen shirt – M', unitPaise: 119900, quantity: 2, retailerId: 'var_1' }],
    totalPaise: 239800,
    taxPaise: 0,
    shippingPaise: 0,
    discountPaise: 0,
    catalogId: '1234567890',
    importer: null,
    beneficiary: address,
    configuration: { name: 'acme-razorpay', provider: 'razorpay' },
    receipt: 'Order #1101',
    expiresAt: new Date('2026-10-25T00:00:00Z'),
    ...over,
});
type Money = { value: number; offset: number };
const order = (p: Record<string, unknown>) => p.order as { items: Array<Record<string, unknown> & { amount: Money; quantity: number }>; subtotal: Money; tax: Money; shipping?: Money; discount?: Money; catalog_id?: string };
const adds = (p: Record<string, unknown>) => {
    const o = order(p);
    const subtotal = o.items.reduce((n, i) => n + i.amount.value * i.quantity, 0);
    return subtotal === o.subtotal.value && (p.total_amount as Money).value === o.subtotal.value + o.tax.value + (o.shipping?.value ?? 0) - (o.discount?.value ?? 0);
};

describe('the WhatsApp Pay bill', () => {
    it('uses the catalog when every item is in it, with the gateway and beneficiary', () => {
        const p = buildOrderDetails(base());
        expect(order(p).catalog_id).toBe('1234567890');
        expect(order(p).items[0]).toMatchObject({ retailer_id: 'var_1', name: 'Linen shirt – M', quantity: 2 });
        expect(p.payment_settings).toEqual([{ type: 'payment_gateway', payment_gateway: { type: 'razorpay', configuration_name: 'acme-razorpay', razorpay: { receipt: 'Order #1101', notes: { collabo_reference: 'cw_abc' } } } }]);
        expect(p.beneficiaries).toEqual([{ ...address, country: 'India' }]);
        expect(adds(p)).toBe(true);
    });

    it('names the importer on every item when one is not in the catalog', () => {
        const importer = { name: 'Acme Apparel Private Limited', address: { name: 'Acme', address_line1: '12 Linking Road', city: 'Mumbai', state: 'Maharashtra', postal_code: '400050' } };
        const p = buildOrderDetails(base({ lines: [...base().lines, { name: 'Gift wrap', unitPaise: 5000, quantity: 1, retailerId: null }], totalPaise: 244800, importer }));
        expect(order(p).catalog_id).toBeUndefined();
        expect(order(p).items.every((i) => i.country_of_origin === 'India' && i.importer_name === importer.name && !('retailer_id' in i))).toBe(true);
        expect(order(p).items[0].importer_address).toMatchObject({ zone_code: 'Maharashtra', country_code: 'IN', postal_code: '400050' });
        expect(() => buildOrderDetails(base({ catalogId: null }))).toThrow(/importer/);
    });

    it('shows tax-inclusive prices net of tax, and the order’s GST as the tax line, adding up exactly', () => {
        // ₹2,398 including 5% GST (₹114.19).
        const p = buildOrderDetails(base({ taxPaise: 11419 }));
        expect(order(p).tax.value).toBeGreaterThan(0);
        expect(Math.abs(order(p).tax.value - 11419)).toBeLessThanOrEqual(2);
        expect(adds(p)).toBe(true);
    });

    it('keeps tax added on top, shipping and discount, and never sends negative tax', () => {
        const onTop = buildOrderDetails(base({ totalPaise: 251790, taxPaise: 11990 }));
        expect(order(onTop).tax.value).toBe(11990);
        const withShipping = buildOrderDetails(base({ totalPaise: 229800, shippingPaise: 5000, discountPaise: 15000 }));
        expect(order(withShipping).shipping?.value).toBe(5000);
        expect(order(withShipping).discount?.value).toBe(15000);
        expect(adds(withShipping)).toBe(true);
        const short = buildOrderDetails(base({ totalPaise: 230000 }));
        expect(order(short).tax.value).toBe(0);
        expect(order(short).discount?.value).toBe(9800);
        expect(adds(short)).toBe(true);
    });
});

describe('a delivery address for WhatsApp Pay', () => {
    it('reads Shopify’s and the CRM’s shapes, in India, with a 6-digit PIN', () => {
        expect(indianAddress({ first_name: 'Meera', last_name: 'Test', address1: '1 MG Road', city: 'Pune', province_code: 'MH', zip: '411 001', country_code: 'IN' }, null)).toEqual(address);
        expect(indianAddress({ address1: '1 MG Road', city: 'Pune', province: 'Maharashtra', zip: '411001' }, 'Meera Test')).toMatchObject({ state: 'Maharashtra', name: 'Meera Test' });
        expect(indianAddress({ address1: '1 Main St', city: 'Austin', province: 'TX', zip: '73301', country_code: 'US' }, 'A')).toBeNull();
        expect(indianAddress({ address1: '1 MG Road', city: 'Pune', province: 'MH', zip: '4110' }, 'A')).toBeNull();
        expect(indianAddress(null, 'A')).toBeNull();
    });

    it('reads Meta’s configuration states however they are spelled', () => {
        expect(configurationActive('Active')).toBe(true);
        expect(configurationActive('Needs_Testing')).toBe(false);
        expect(configurationActive('Needs Testing')).toBe(false);
    });
});
