import { BadRequestException } from '@nestjs/common';
import { collectIssues, keywordsFor, parseDefinition, reidSteps, triggerPostFor, triggerTypeFor } from './definition.schema';

const ctx = { platform: 'INSTAGRAM', knownMediaIds: null };
const trigger = (config: Record<string, unknown>) => ({ id: 't', type: 'trigger', config: { channel: 'instagram', event: 'comment', ...config } });
const codes = (steps: unknown[], platform = 'INSTAGRAM') => collectIssues(parseDefinition({ steps }), { platform, knownMediaIds: null }).map((i) => i.code);

describe('parseDefinition', () => {
    it('reads a tree with every branch filled in', () => {
        const steps = parseDefinition({
            steps: [
                trigger({ keyword: 'price' }),
                { id: 'r', type: 'reply_comment', config: { message: 'Check your DMs!' } },
                { id: 'w', type: 'wait_for_reply', config: {}, branches: { replied: [{ id: 'n', type: 'add_note', config: { text: 'replied' } }] } },
            ],
        });
        expect(steps[2].branches).toEqual({ replied: [{ id: 'n', type: 'add_note', config: { text: 'replied' } }], timeout: [] });
        expect(steps[2].config).toMatchObject({ amount: 24, unit: 'hours' });
    });

    it('refuses what cannot run', () => {
        const bad = (steps: unknown[]) => () => parseDefinition({ steps });
        expect(bad([{ id: 'a', type: 'add_note', config: {} }])).toThrow('first step must be the trigger');
        expect(bad([trigger({}), { id: 'x', type: 'teleport', config: {} }])).toThrow('unknown block');
        expect(bad([trigger({}), { id: 't', type: 'add_note', config: {} }])).toThrow('Duplicate step id');
        expect(bad([trigger({}), { id: 'n', type: 'add_note', config: {}, branches: { yes: [] } }])).toThrow('has no branches');
        expect(bad([trigger({}), { id: 'c', type: 'condition', config: {}, branches: { maybe: [] } }])).toThrow('unknown branch');
        expect(bad([trigger({}), { id: 'c', type: 'condition', config: {}, branches: { yes: [trigger({})] } }])).toThrow(BadRequestException);
    });
});

describe('collectIssues', () => {
    it('accepts a complete comment-to-DM flow', () => {
        expect(
            codes([
                trigger({ keyword: 'price' }),
                { id: 'r', type: 'reply_comment', config: { mode: 'private', message: 'Hi {{first_name}}! Want the link?' } },
                {
                    id: 'w',
                    type: 'wait_for_reply',
                    config: { saveAs: 'answer' },
                    branches: { replied: [{ id: 'm', type: 'send_message', config: { message: 'Here: {{attr.answer}}' } }], timeout: [] },
                },
            ]),
        ).toEqual([]);
    });

    it('requires a private reply before DMs to a commenter, and only one', () => {
        expect(codes([trigger({ keyword: 'x' }), { id: 'm', type: 'send_message', config: { message: 'hi' } }])).toContain('needs_reply_first');
        expect(
            codes([
                trigger({ keyword: 'x' }),
                { id: 'a', type: 'reply_comment', config: { message: 'a' } },
                { id: 'b', type: 'reply_comment', config: { message: 'b' } },
            ]),
        ).toContain('one_private_reply');
    });

    it('checks each channel’s rules', () => {
        const wa = (step: unknown) => codes([{ id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'message', match: 'any' } }, step], 'WHATSAPP');
        expect(wa({ id: 'm', type: 'send_message', config: { kind: 'quick_replies', message: 'x', options: ['a'] } })).toContain('quick_replies_not_whatsapp');
        expect(wa({ id: 'm', type: 'send_message', config: { kind: 'buttons', message: 'x', options: ['a', 'b', 'c', 'd'] } })).toContain('too_many_buttons');
        expect(wa({ id: 'm', type: 'send_message', config: { kind: 'template' } })).toContain('template_missing');
        expect(codes([{ id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'comment' } }, { id: 'n', type: 'add_note', config: { text: 'x' } }], 'WHATSAPP')).toContain('event_unavailable');
        expect(codes([trigger({ keyword: 'x' }), { id: 'm', type: 'send_message', config: { kind: 'list', message: 'x', options: ['a'] } }])).toContain('list_needs_whatsapp');
    });

    it('knows which variables exist at each step', () => {
        const flow = (text: string) =>
            codes([
                { id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'message', match: 'any' } },
                { id: 'h', type: 'http_request', config: { url: 'https://example.com', saveAs: 'order' } },
                { id: 'm', type: 'send_message', config: { message: text } },
            ], 'WHATSAPP');
        expect(flow('Status: {{order.status}} for {{first_name}} in {{attr.city}}')).toEqual([]);
        expect(flow('{{shoe_size}}')).toContain('unknown_variable');
    });

    it('flags empty steps and the invoice block that cannot run yet', () => {
        expect(codes([trigger({ match: 'contains', keyword: '' })])).toEqual(expect.arrayContaining(['keyword_missing', 'no_action']));
        expect(codes([trigger({ keyword: 'x' }), { id: 'i', type: 'send_invoice', config: {} }])).toContain('not_available_yet');
        expect(codes([trigger({ keyword: 'x' }), { id: 'c', type: 'condition', config: {} }])).toContain('rules_missing');
        expect(codes([trigger({ keyword: 'x' }), { id: 'a', type: 'assign', config: { mode: 'user' } }])).toContain('assignee_missing');
    });
});

describe('trigger helpers', () => {
    it('derives the row the matcher reads', () => {
        const [t] = parseDefinition({ steps: [trigger({ keyword: 'Price, PRICE , link', post: '1789' })] });
        expect(triggerTypeFor(t)).toBe('instagram.comment');
        expect(keywordsFor(t)).toEqual(['price', 'link']);
        expect(triggerPostFor(t)).toBe('1789');
        const [tag] = parseDefinition({ steps: [{ id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'tag_added', tag: 'VIP' } }] });
        expect([triggerTypeFor(tag), keywordsFor(tag)]).toEqual(['crm.contact.tag_added', ['VIP']]);
        const [pb] = parseDefinition({ steps: [{ id: 't', type: 'trigger', config: { channel: 'facebook', event: 'postback', keyword: 'TALK_TO_AGENT' } }] });
        expect(keywordsFor(pb)).toEqual(['TALK_TO_AGENT']);
    });

    it('gives copies fresh ids all the way down and a new webhook URL', () => {
        const steps = parseDefinition({
            steps: [
                { id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'webhook', token: 'secret' } },
                { id: 'c', type: 'condition', config: {}, branches: { yes: [{ id: 'y', type: 'add_note', config: {} }] } },
            ],
        });
        const copy = reidSteps(steps);
        expect(copy[0].config.token).toBe('');
        expect(copy[1].id).not.toBe('c');
        expect(copy[1].branches!.yes[0].id).not.toBe('y');
    });
});

describe('store triggers', () => {
    const wa = (event: string, steps: unknown[]) =>
        codes([{ id: 't', type: 'trigger', config: { channel: 'whatsapp', event, keyword: 'stale words' } }, ...steps], 'WHATSAPP');

    it('map to store event types and ignore leftover keywords', () => {
        const [t] = parseDefinition({ steps: [{ id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'order_paid', keyword: 'price' } }] });
        expect([triggerTypeFor(t), keywordsFor(t)]).toEqual(['crm.order.paid', []]);
        const [c] = parseDefinition({ steps: [{ id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'checkout_abandoned' } }] });
        expect(triggerTypeFor(c)).toBe('crm.checkout.abandoned');
        const [cart] = parseDefinition({ steps: [{ id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'cart' } }] });
        expect(triggerTypeFor(cart)).toBe('whatsapp.cart');
    });

    it('need templates, and know {{order.*}} and {{draft.*}}', () => {
        expect(wa('order_created', [{ id: 'm', type: 'send_message', config: { message: 'Thanks for {{order.name}}' } }])).toContain('template_needed');
        expect(wa('order_created', [{ id: 'n', type: 'add_note', config: { text: 'COD {{order.total}}' } }])).toEqual([]);
        expect(
            wa('cart', [
                { id: 'd', type: 'store_action', config: { action: 'create_draft_order' } },
                { id: 'm', type: 'send_message', config: { message: 'Pay here: {{draft.checkout_url}}' } },
            ]),
        ).toEqual([]);
    });

    it('check store actions fit the trigger', () => {
        expect(wa('cart', [{ id: 'a', type: 'store_action', config: { action: 'tag_order', value: 'x' } }])).toContain('needs_order');
        expect(wa('order_created', [{ id: 'a', type: 'store_action', config: { action: 'create_draft_order' } }])).toContain('needs_cart');
        expect(wa('order_created', [{ id: 'a', type: 'store_action', config: { action: 'tag_order' } }])).toContain('value_missing');
        expect(codes([trigger({ keyword: 'x' })].concat([{ id: 'n', type: 'add_note', config: { text: 'x' } }] as never), 'INSTAGRAM')).not.toContain('event_unavailable');
        expect(codes([{ id: 't', type: 'trigger', config: { channel: 'instagram', event: 'order_paid' } }, { id: 'n', type: 'add_note', config: { text: 'x' } }])).toContain('event_unavailable');
    });

    it('keep store actions to WhatsApp', () => {
        const tagCustomer = { id: 'a', type: 'store_action', config: { action: 'tag_customer', value: 'vip' } };
        expect(codes([trigger({ match: 'any' }), tagCustomer] as never, 'INSTAGRAM')).toContain('store_needs_whatsapp');
        expect(codes([{ id: 't', type: 'trigger', config: { channel: 'facebook', event: 'message', match: 'any' } }, tagCustomer], 'FACEBOOK')).toContain('store_needs_whatsapp');
        expect(wa('message', [tagCustomer])).not.toContain('store_needs_whatsapp');
    });
});

describe('template steps', () => {
    const templates = new Map([
        ['tpl_cod', { name: 'cod_order_confirmation', params: [{ key: 'body.first_name', name: 'first_name', kind: 'text' }, { key: 'body.order_number', name: 'order_number', kind: 'text' }] }],
        ['tpl_img', { name: 'sale_photo', params: [{ key: 'header', name: 'media', kind: 'image' }] }],
    ]);
    const send = (config: Record<string, unknown>) => [
        { id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'order_created' } },
        { id: 'm', type: 'send_message', config: { kind: 'template', ...config } },
    ];
    const check = (steps: unknown[], withTemplates = true) =>
        collectIssues(parseDefinition({ steps }), { platform: 'WHATSAPP', knownMediaIds: null, ...(withTemplates ? { templates } : {}) }).map((i) => i.code);

    it('need a value for every parameter of the chosen template', () => {
        expect(check(send({ templateId: 'tpl_cod', templateValues: { 'body.1': '{{first_name}}' } }))).toEqual(['template_value_missing', 'template_value_missing']);
        expect(check(send({ templateId: 'tpl_cod', templateValues: { 'body.first_name': '{{first_name}}', 'body.order_number': '{{order.name}}' } }))).toEqual([]);
        expect(check(send({ templateId: 'tpl_img', templateValues: {} }))).toEqual(['template_media_missing']);
        expect(check(send({ templateId: 'tpl_img', templateValues: {}, media: { storageKey: 'org/x.png', mime: 'image/png', kind: 'image' } }))).toEqual([]);
        expect(check(send({ templateId: 'tpl_gone', templateValues: {} }))).toEqual(['template_not_found']);
        expect(check(send({ templateId: 'tpl_cod', templateValues: {} }), false)).toEqual([]);
    });
});
