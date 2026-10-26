import { conditionMatches, flattenResponse, parseRunContext, RunFacts, variablesFor } from './run-context';

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
    contact: { name: '@riya.k', username: 'riya.k', phone: null, tags: ['VIP'], attributes: { size: '9', city: 'Pune' }, optedIn: true, optedOut: false },
    customer: null,
    conversation: { assignedUserId: null, windowOpen: true },
    context: parseRunContext({ vars: { trigger_text: 'What is the PRICE?', last_reply: 'yes please' } }),
    ...over,
});
const rule = (field: string, op: string, value = '', key = '') => ({ match: 'all' as const, rules: [{ field, op, value, key }] as never });

describe('variablesFor', () => {
    it('prefers the store customer’s name and exposes attributes', () => {
        expect(variablesFor(facts())).toMatchObject({ first_name: 'riya.k', 'attr.size': '9', trigger_text: 'What is the PRICE?' });
        expect(variablesFor(facts({ customer: { firstName: 'Riya', lastName: 'Kapoor', ordersCount: 2, tags: [] } }))).toMatchObject({ first_name: 'Riya', name: 'Riya Kapoor' });
        expect(variablesFor(facts({ contact: { ...facts().contact, name: '+91 98000 00000' } })).first_name).toBeNull();
    });

    it('falls back to the name typed at checkout for a contact known only by number', () => {
        const checkout = (contactName: string | null) =>
            variablesFor(facts({ contact: { ...facts().contact, name: contactName }, context: parseRunContext({ vars: { 'checkout.first_name': 'Meera' } }) }));
        expect(checkout(null)).toMatchObject({ first_name: 'Meera', name: 'Meera' });
        expect(checkout('+91 98000 00000').first_name).toBe('Meera');
        expect(checkout('Riya Kapoor')).toMatchObject({ first_name: 'Riya', name: 'Riya Kapoor' });
    });
});

describe('conditionMatches', () => {
    it('reads replies, tags, attributes, consent, orders and the window', () => {
        expect(conditionMatches(rule('last_reply', 'contains', 'yes, sure'), facts())).toBe(true);
        expect(conditionMatches(rule('trigger_text', 'contains', 'price'), facts())).toBe(true);
        expect(conditionMatches(rule('tag', 'has', 'vip'), facts())).toBe(true);
        expect(conditionMatches(rule('tag', 'not_has', 'vip'), facts())).toBe(false);
        expect(conditionMatches(rule('attribute', 'gte', '8', 'size'), facts())).toBe(true);
        expect(conditionMatches(rule('attribute', 'equals', 'pune', 'city'), facts())).toBe(true);
        expect(conditionMatches(rule('attribute', 'exists', '', 'email'), facts())).toBe(false);
        expect(conditionMatches(rule('consent', 'is', 'opted_in'), facts())).toBe(true);
        expect(conditionMatches(rule('customer', 'exists'), facts())).toBe(false);
        expect(conditionMatches(rule('orders_count', 'gte', '1'), facts({ customer: { firstName: null, lastName: null, ordersCount: 3, tags: [] } }))).toBe(true);
        expect(conditionMatches(rule('window', 'is', 'open'), facts())).toBe(true);
        expect(conditionMatches(rule('assigned', 'not_exists'), facts())).toBe(true);
    });

    it('combines rules with all or any, and an empty rule list never matches', () => {
        const two = [{ field: 'tag', op: 'has', value: 'vip', key: '' }, { field: 'customer', op: 'exists', value: '', key: '' }] as never;
        expect(conditionMatches({ match: 'all', rules: two }, facts())).toBe(false);
        expect(conditionMatches({ match: 'any', rules: two }, facts())).toBe(true);
        expect(conditionMatches({ match: 'all', rules: [] }, facts())).toBe(false);
    });
});

describe('flattenResponse', () => {
    it('keeps top-level and one nested level as text', () => {
        expect(flattenResponse('order', { status: 'shipped', items: 2, tracking: { url: 'https://t.co/x' }, list: [1] }, 200)).toEqual({
            'order.status_code': '200',
            'order.status': 'shipped',
            'order.items': '2',
            'order.tracking.url': 'https://t.co/x',
        });
        expect(flattenResponse('x', 'plain text', 201)).toEqual({ 'x.status_code': '201' });
    });
});

describe('order conditions', () => {
    it('tell cash on delivery from prepaid, and compare totals', () => {
        const cod = facts({ order: { isCod: true, total: 1499 } });
        expect(conditionMatches(rule('order_payment', 'is', 'cod'), cod)).toBe(true);
        expect(conditionMatches(rule('order_payment', 'is', 'prepaid'), cod)).toBe(false);
        expect(conditionMatches(rule('order_total', 'gte', '1000'), cod)).toBe(true);
        expect(conditionMatches(rule('order_payment', 'is', 'cod'), facts())).toBe(false);
    });
});

describe('parseRunContext', () => {
    it('keeps every reply event a run took, and drops unknown keys', () => {
        const ctx = parseRunContext({ vars: { a: '1' }, replied: true, replyEventIds: ['evt_1', 'evt_2'], stray: 'x' });
        expect(ctx).toEqual({ vars: { a: '1' }, trigger: { eventType: '', commentId: null, postId: null }, depth: 0, replied: true, replyEventIds: ['evt_1', 'evt_2'] });
    });

    it('keeps the send a run is holding back', () => {
        expect(parseRunContext({ hold: { stepId: 's1', reason: 'quiet_hours' } }).hold).toEqual({ stepId: 's1', reason: 'quiet_hours' });
        expect(parseRunContext({ hold: {} }).hold).toBeUndefined();
    });
});

describe('the tapped button’s payload', () => {
    const tapped = (payload: string | undefined, reply = 'Confirmar pedido') =>
        facts({ context: parseRunContext({ vars: { last_reply: reply, ...(payload ? { last_reply_payload: payload } : {}) } }) });
    const confirm = rule('reply_payload', 'equals', 'collabo_cod_confirm');

    it('matches whatever the button says, and nothing without a payload', () => {
        expect(conditionMatches(confirm, tapped('collabo_cod_confirm'))).toBe(true);
        expect(conditionMatches(confirm, tapped('collabo_cod_cancel'))).toBe(false);
        expect(conditionMatches(confirm, tapped(undefined, 'collabo_cod_confirm'))).toBe(false);
        expect(conditionMatches(rule('reply_payload', 'exists'), tapped(undefined))).toBe(false);
    });

    it('sits beside the words, for replies typed or tapped on an older template', () => {
        const either = { match: 'any' as const, rules: [...confirm.rules, ...rule('last_reply', 'equals', 'confirm order, confirm, yes').rules] };
        expect(conditionMatches(either, tapped('collabo_cod_confirm'))).toBe(true);
        expect(conditionMatches(either, tapped(undefined, 'Confirm order'))).toBe(true);
        expect(conditionMatches(either, tapped(undefined, 'When will it arrive?'))).toBe(false);
    });
});

describe('the COD playbook’s reply rules', () => {
    // Whole replies decide; anything else ("Please don't cancel") goes to the team.
    const confirm = rule('last_reply', 'equals', 'confirm, confirm order, yes');
    const cancel = rule('last_reply', 'equals', 'cancel, cancel order, cancel my order');
    const said = (text: string) => facts({ context: parseRunContext({ vars: { last_reply: text } }) });
    it('confirms and cancels only on those words', () => {
        for (const t of ['Confirm order', 'confirm', ' YES ']) expect([t, conditionMatches(confirm, said(t))]).toEqual([t, true]);
        for (const t of ['Cancel order', 'cancel']) expect([t, conditionMatches(cancel, said(t))]).toEqual([t, true]);
        for (const t of ['Please don’t cancel, I need it', 'Can I cancel later?', 'Yes, cancel it', 'I don’t want to confirm', 'When will it arrive?']) {
            expect([t, conditionMatches(confirm, said(t)), conditionMatches(cancel, said(t))]).toEqual([t, false, false]);
        }
    });
});
