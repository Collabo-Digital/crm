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
    it('keeps the event of the last reply a run took, and drops unknown keys', () => {
        const ctx = parseRunContext({ vars: { a: '1' }, replied: true, replyEventId: 'evt_1', stray: 'x' });
        expect(ctx).toEqual({ vars: { a: '1' }, trigger: { eventType: '', commentId: null, postId: null }, depth: 0, replied: true, replyEventId: 'evt_1' });
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
