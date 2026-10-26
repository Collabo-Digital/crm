import { collectIssues, parseDefinition, triggerTypeFor } from '../blocks/definition.schema';
import { templatePack } from '../../campaigns/templates/pack/template-pack';
import { readCartDiscount } from './cart-discount';
import { MANAGED_AUTOMATIONS, MANAGED_BY_KEY, registryMatch, templateSlotsIn } from './managed-automations';

const discount = { code: 'SAVE10', text: '10%', validDays: 7 };
const settings = [{ cartDiscount: null }, { cartDiscount: discount }];
const slots = new Map(templatePack('https://app.example.com').map((s) => [s.key as string, s]));

describe('the recommended automations', () => {
    it('each publishes as built: WhatsApp, pack slots only, every value available where it is sent', () => {
        for (const entry of MANAGED_AUTOMATIONS) {
            for (const s of settings) {
                const steps = parseDefinition({ steps: entry.steps(s) });
                expect([entry.packKey, collectIssues(steps, { platform: 'WHATSAPP', knownMediaIds: null, templates: new Map(), paymentsConnected: false })]).toEqual([entry.packKey, []]);
                expect(steps[0].config).toMatchObject({ channel: 'whatsapp', skipPos: true });
                for (const slot of templateSlotsIn(steps)) expect([entry.packKey, slots.has(slot)]).toEqual([entry.packKey, true]);
            }
        }
    });

    it('confirm a cash-on-delivery order, ask again once and tag it if nobody answers, within four levels', () => {
        const steps = parseDefinition({ steps: MANAGED_BY_KEY.get('cod_confirmation')!.steps({ cartDiscount: null }) });
        expect(triggerTypeFor(steps[0])).toBe('crm.order.created');
        expect(templateSlotsIn(steps)).toEqual(['cod_confirm', 'order_confirmed']);
        const json = JSON.stringify(steps);
        for (const s of ['collabo_cod_confirm', 'collabo_cod_cancel', 'cod-confirmed', 'cod-unconfirmed', 'cancel_order', '"amount":3', '"amount":21']) expect([s, json.includes(s)]).toEqual([s, true]);
    });

    it('leave out till sales, old orders’ invoices, and send cart reminder 3 only with a discount', () => {
        expect(MANAGED_BY_KEY.get('gst_invoice')!.steps({ cartDiscount: null })[0].config).toMatchObject({ event: 'invoice_issued', orderWithinDays: 3 });
        const cart = MANAGED_BY_KEY.get('cart_recovery')!;
        expect(cart.steps({ cartDiscount: null })[0].config.stopWhen).toEqual({ orderPlaced: true, replied: true, optedOut: true });
        expect(templateSlotsIn(cart.steps({ cartDiscount: null }))).toEqual(['cart_reminder_1', 'cart_reminder_2']);
        expect(templateSlotsIn(cart.steps({ cartDiscount: discount }))).toEqual(['cart_reminder_1', 'cart_reminder_2', 'cart_reminder_3']);
    });

    it('are on by default except the review request, and cart recovery needs an online store', () => {
        expect(MANAGED_AUTOMATIONS.filter((m) => !m.defaultOn).map((m) => m.packKey)).toEqual(['review_request']);
        expect(MANAGED_AUTOMATIONS.filter((m) => m.set !== 'core').map((m) => [m.packKey, m.set])).toEqual([['cart_recovery', 'online_store']]);
    });
});

describe('registryMatch', () => {
    const cart = MANAGED_BY_KEY.get('cart_recovery')!;
    const stored = (steps: unknown[]) => JSON.parse(JSON.stringify({ steps: parseDefinition({ steps }) }));

    it('tells the registry’s own definition, one built for other settings, and the merchant’s edit apart', () => {
        expect(registryMatch(cart, stored(cart.steps({ cartDiscount: null })), { cartDiscount: null })).toBe('current');
        expect(registryMatch(cart, stored(cart.steps({ cartDiscount: null })), { cartDiscount: discount })).toBe('stale');
        expect(registryMatch(cart, stored(cart.steps({ cartDiscount: discount })), { cartDiscount: null })).toBe('stale');
        const edited = cart.steps({ cartDiscount: null }).map((s) => (s.id === 'pk_reminder_1' ? { ...s, config: { kind: 'template', templateId: 'tpl_mine' } } : s));
        expect(registryMatch(cart, stored(edited), { cartDiscount: null })).toBe('edited');
        expect(registryMatch(cart, { steps: 'broken' }, { cartDiscount: null })).toBe('edited');
    });

    it('ignores key order, as Postgres stores JSON', () => {
        const entry = MANAGED_BY_KEY.get('order_shipped')!;
        const reversed = (v: unknown): unknown =>
            Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v;
        expect(registryMatch(entry, reversed(stored(entry.steps({ cartDiscount: null }))), { cartDiscount: null })).toBe('current');
    });
});

describe('readCartDiscount', () => {
    it('reads a complete discount and nothing else', () => {
        expect(readCartDiscount({ cartDiscount: discount, replaced: { order_shipped: 2 } })).toEqual(discount);
        expect(readCartDiscount({ cartDiscount: { code: 'X1', text: '', validDays: 3 } })).toBeNull();
        expect(readCartDiscount({ cartDiscount: { code: 'X1', text: '5%', validDays: 0 } })).toBeNull();
        expect(readCartDiscount(null)).toBeNull();
    });
});
