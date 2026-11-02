import { BadRequestException } from '@nestjs/common';
import { collectIssues, keywordsFor, parseDefinition, reidSteps, triggerConfigFor, triggerPostFor, triggerTypeFor } from './definition.schema';

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

    it('flags empty steps, and an invoice sent outside an order on WhatsApp', () => {
        expect(codes([trigger({ match: 'contains', keyword: '' })])).toEqual(expect.arrayContaining(['keyword_missing', 'no_action']));
        expect(codes([trigger({ keyword: 'x' }), { id: 'i', type: 'send_invoice', config: {} }])).toEqual(expect.arrayContaining(['invoice_needs_whatsapp', 'invoice_needs_order', 'template_missing']));
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
        // A webhook can name a number that has never written.
        expect(wa('webhook', [{ id: 'm', type: 'send_message', config: { message: 'Your order is ready' } }])).toContain('template_needed');
        expect(wa('webhook', [{ id: 'm', type: 'send_message', config: { kind: 'buttons', message: 'Confirm?', options: ['Yes', 'No'] } }])).toContain('template_needed');
        expect(wa('message', [{ id: 'm', type: 'send_message', config: { message: 'Hi' } }])).not.toContain('template_needed');
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

describe('sending the invoice', () => {
    const templates = new Map([
        ['tpl_doc', { name: 'invoice_ready', params: [{ key: 'header', name: 'media', kind: 'document' }, { key: 'body.invoice_number', name: 'invoice_number', kind: 'text' }] }],
        ['tpl_img', { name: 'sale_photo', params: [{ key: 'header', name: 'media', kind: 'image' }] }],
    ]);
    const steps = (event: string, config: Record<string, unknown>) => [
        { id: 't', type: 'trigger', config: { channel: 'whatsapp', event } },
        { id: 'i', type: 'send_invoice', config },
    ];
    const check = (s: unknown[]) => collectIssues(parseDefinition({ steps: s }), { platform: 'WHATSAPP', knownMediaIds: null, templates }).map((i) => i.code);

    it('runs on the invoice event and on order events, with a document-header template filled in', () => {
        expect(triggerTypeFor(parseDefinition({ steps: steps('invoice_issued', {}) })[0])).toBe('crm.invoice.issued');
        expect(check(steps('invoice_issued', { templateId: 'tpl_doc', templateValues: { 'body.invoice_number': '{{invoice.number}}' } }))).toEqual([]);
        expect(check(steps('order_paid', { templateId: 'tpl_doc', templateValues: { 'body.invoice_number': '{{invoice.number}}' } }))).toEqual([]);
        expect(check(steps('invoice_issued', { templateId: 'tpl_doc', templateValues: {} }))).toEqual(['template_value_missing']);
        expect(check(steps('invoice_issued', { templateId: 'tpl_img' }))).toEqual(['template_needs_document']);
        expect(check(steps('cart', { templateId: 'tpl_doc', templateValues: { 'body.invoice_number': 'x' } }))).toEqual(['invoice_needs_order']);
    });
});

describe('sending a payment link', () => {
    const templates = new Map([
        ['tpl_pay', { name: 'cod_pay_online', params: [{ key: 'body.first_name', name: 'first_name', kind: 'text' }, { key: 'button.0', name: '0', kind: 'text' }] }],
        ['tpl_img', { name: 'sale_photo', params: [{ key: 'header', name: 'media', kind: 'image' }] }],
    ]);
    const filled = { templateId: 'tpl_pay', templateValues: { 'body.first_name': '{{first_name}}', 'button.0': '{{payment.link_path}}' } };
    const check = (s: unknown[], paymentsConnected = true) =>
        collectIssues(parseDefinition({ steps: s }), { platform: 'WHATSAPP', knownMediaIds: null, templates, paymentsConnected }).map((i) => i.code);
    const onOrder = (config: Record<string, unknown>, event = 'order_created') => [
        { id: 't', type: 'trigger', config: { channel: 'whatsapp', event } },
        { id: 'p', type: 'send_payment_link', config },
    ];

    it('collects for the order the trigger is about, with the link in a template button', () => {
        expect(check(onOrder(filled))).toEqual([]);
        expect(check(onOrder({ ...filled, templateValues: { 'body.first_name': 'x', 'button.0': 'fixed' } }))).toEqual(['payment_link_unused']);
        expect(check(onOrder({ templateId: 'tpl_img' }))).toEqual(['template_header_unsupported', 'payment_link_unused']);
        expect(check(onOrder(filled), false)).toEqual(['payments_not_connected']);
        expect(check(onOrder(filled, 'payment_received'))).toEqual(['payment_already_paid']);
    });

    it('collects for a cart once a draft order was made from it, and text is fine after a cart', () => {
        const cart = (draftFirst: boolean) => [
            { id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'cart' } },
            ...(draftFirst ? [{ id: 'd', type: 'store_action', config: { action: 'create_draft_order' } }] : []),
            { id: 'p', type: 'send_payment_link', config: { kind: 'text', message: 'Pay {{payment.amount}} here: {{payment.link}}' } },
        ];
        expect(check(cart(true))).toEqual([]);
        expect(check(cart(false))).toEqual(['payment_needs_order']);
    });

    it('needs a template on store events, like any message there, and the link in the text', () => {
        expect(check(onOrder({ kind: 'text', message: 'Pay here: {{payment.link}}' }))).toEqual(['template_needed']);
        expect(check(onOrder({ kind: 'text', message: 'Pay soon' }))).toEqual(['payment_link_unused', 'template_needed']);
    });

    it('starts on a paid link, with {{payment.*}} and the order available', () => {
        const steps = [
            { id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'payment_received' } },
            { id: 'n', type: 'add_note', config: { text: 'Paid {{payment.amount}} by {{payment.method}} for {{order.name}}' } },
        ];
        expect(triggerTypeFor(parseDefinition({ steps })[0])).toBe('crm.payment.received');
        expect(check(steps)).toEqual([]);
    });
});

describe('asking for WhatsApp Pay', () => {
    const steps = (event: string, inside = false) => [
        { id: 't', type: 'trigger', config: { channel: 'whatsapp', event } },
        ...(event === 'cart' ? [{ id: 'd', type: 'store_action', config: { action: 'create_draft_order' } }] : []),
        ...(inside
            ? [{ id: 'w', type: 'wait_for_reply', config: { amount: 1, unit: 'hours' }, branches: { replied: [{ id: 'p', type: 'send_payment_link', config: { method: 'whatsapp_pay' } }], timeout: [] } }]
            : [{ id: 'p', type: 'send_payment_link', config: { method: 'whatsapp_pay', message: 'Your order comes to {{payment.amount}}' } }]),
    ];
    const check = (s: unknown[], whatsAppPayReady = true) =>
        collectIssues(parseDefinition({ steps: s }), { platform: 'WHATSAPP', knownMediaIds: null, templates: new Map(), whatsAppPayReady }).map((i) => i.code);

    it('goes right after a cart or a reply, needs no template and no Razorpay account', () => {
        expect(check(steps('cart'))).toEqual([]);
        expect(check(steps('order_created', true))).toEqual([]);
        expect(check(steps('order_created'))).toEqual(['whatsapp_pay_needs_window']);
        expect(check(steps('cart'), false)).toEqual(['whatsapp_pay_not_ready']);
    });
});

describe('a website sign-up', () => {
    it('starts an automation with {{signup.*}}, and needs a template since they have not written', () => {
        const steps = (message: Record<string, unknown>) => [
            { id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'website_signup' } },
            { id: 'm', type: 'send_message', config: message },
        ];
        const check = (s: unknown[]) => collectIssues(parseDefinition({ steps: s }), { platform: 'WHATSAPP', knownMediaIds: null }).map((i) => i.code);
        expect(triggerTypeFor(parseDefinition({ steps: steps({ kind: 'text', message: 'x' }) })[0])).toBe('crm.website.signup');
        expect(check(steps({ kind: 'text', message: 'Welcome {{signup.name}}' }))).toEqual(['template_needed']);
        expect(check(steps({ kind: 'template', templateId: 't1', templateValues: { 'body.1': '{{signup.name}}' } }))).toEqual([]);
    });
});

describe('a chat from an ad', () => {
    const steps = (keyword: string, channel = 'whatsapp') => [
        { id: 't', type: 'trigger', config: { channel, event: 'ad_message', keyword } },
        { id: 'm', type: 'send_message', config: { kind: 'text', message: 'Thanks for tapping our {{ad.headline}} ad!' } },
    ];
    const check = (s: unknown[], platform = 'WHATSAPP') => collectIssues(parseDefinition({ steps: s }), { platform, knownMediaIds: null }).map((i) => i.code);

    it('starts on any ad or the ones named, on every channel, and can reply in text', () => {
        const any = parseDefinition({ steps: steps('') })[0];
        expect(triggerTypeFor(any)).toBe('crm.ad.referral');
        expect(keywordsFor(any)).toEqual([]);
        expect(keywordsFor(parseDefinition({ steps: steps(' 120210000000001, 120210000000002 ,120210000000001') })[0])).toEqual(['120210000000001', '120210000000002']);
        expect(check(steps(''))).toEqual([]);
        expect(check(steps('', 'instagram'), 'INSTAGRAM')).toEqual([]);
        expect(check(steps('', 'facebook'), 'FACEBOOK')).toEqual([]);
        expect(check(steps('summer-sale'))).toEqual(['ad_id_invalid']);
    });
});

describe('publishing a review', () => {
    const steps = (event: string, config: Record<string, unknown> = {}, channel = 'whatsapp') => [
        { id: 't', type: 'trigger', config: { channel, event } },
        { id: 'r', type: 'post_review', config },
    ];
    const check = (s: unknown[], platform = 'WHATSAPP') => collectIssues(parseDefinition({ steps: s }), { platform, knownMediaIds: null }).map((i) => i.code);

    it('reads the saved rating and the reply just received by default', () => {
        const [, r] = parseDefinition({ steps: steps('order_delivered') });
        expect(r.config).toEqual({ rating: '{{attr.review_rating}}', text: '{{last_reply}}', products: 'first', nameFormat: 'last_initial' });
        expect(check(steps('order_delivered'))).toEqual([]);
    });

    it('is for the order the trigger is about, on WhatsApp, with a rating to read', () => {
        expect(check(steps('message'))).toContain('review_needs_order');
        expect(check(steps('order_delivered', { rating: '  ' }))).toContain('rating_missing');
        expect(check(steps('message', {}, 'instagram'), 'INSTAGRAM')).toContain('store_needs_whatsapp');
    });
});

describe('Google sheets', () => {
    const rowTrigger = (config: Record<string, unknown> = {}) => ({ id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'sheet_row', sheetId: 'sh1', phoneField: 'Phone', ...config } });
    const addRow = (config: Record<string, unknown>) => ({ id: 'a', type: 'sheet_add_row', config });
    const check = (steps: unknown[], sheets?: Set<string>) =>
        collectIssues(parseDefinition({ steps }), { platform: 'WHATSAPP', knownMediaIds: null, sheets }).map((i) => i.code);

    it('starts on a new row of a sheet, for the person in its phone column', () => {
        const [t] = parseDefinition({ steps: [rowTrigger()] });
        expect([triggerTypeFor(t), triggerPostFor(t)]).toEqual(['crm.sheet.row', 'sh1']);
        expect(check([rowTrigger(), { id: 'n', type: 'add_note', config: { text: 'New lead {{sheet.full_name}} in row {{sheet.row}}' } }])).toEqual([]);
    });

    it('needs its sheet and phone column, and templates for people who have not written', () => {
        expect(check([rowTrigger({ sheetId: '' }), { id: 'n', type: 'add_note', config: { text: 'x' } }])).toContain('sheet_missing');
        expect(check([rowTrigger({ phoneField: ' ' }), { id: 'n', type: 'add_note', config: { text: 'x' } }])).toContain('phone_column_missing');
        expect(check([rowTrigger(), { id: 'n', type: 'add_note', config: { text: 'x' } }], new Set(['other']))).toContain('sheet_not_found');
        expect(check([rowTrigger(), { id: 'm', type: 'send_message', config: { message: 'Hi {{sheet.name}}' } }])).toContain('template_needed');
    });

    it('adds a row to a sheet from any automation, but never to the sheet that started it', () => {
        const message = { id: 't', type: 'trigger', config: { channel: 'instagram', event: 'message', match: 'any' } };
        expect(collectIssues(parseDefinition({ steps: [message, addRow({ sheetId: 'sh2', values: ['{{name}}', '{{last_reply}}'] })] }), { platform: 'INSTAGRAM', knownMediaIds: null }).map((i) => i.code)).toEqual([]);
        expect(check([rowTrigger(), addRow({ sheetId: 'sh1', values: ['x'] })])).toContain('sheet_loop');
        expect(check([rowTrigger(), addRow({ sheetId: 'sh2', values: ['', ' '] })])).toContain('row_empty');
        expect(check([rowTrigger(), addRow({ sheetId: '', values: ['x'] })])).toContain('sheet_missing');
    });
});

describe('the recommended pack', () => {
    const wa = (trigger: Record<string, unknown>, ...steps: unknown[]) => [{ id: 't', type: 'trigger', config: { channel: 'whatsapp', ...trigger } }, ...steps];
    const slot = (templateSlot: string, extra: Record<string, unknown> = {}) => ({ id: 'm', type: 'send_message', config: { kind: 'template', templateSlot, ...extra } });
    const check = (steps: unknown[]) => collectIssues(parseDefinition({ steps }), { platform: 'WHATSAPP', knownMediaIds: null, templates: new Map() }).map((i) => i.code);

    it('starts on out for delivery and on each refund, as order events', () => {
        const [ofd] = parseDefinition({ steps: wa({ event: 'order_out_for_delivery' }) });
        const [refund] = parseDefinition({ steps: wa({ event: 'order_refunded' }) });
        expect([triggerTypeFor(ofd), triggerTypeFor(refund)]).toEqual(['crm.order.out_for_delivery', 'crm.order.refunded']);
        expect(check(wa({ event: 'order_refunded' }, { id: 'n', type: 'add_note', config: { text: 'Refunded {{refund.amount}} on {{order.name}}' } }))).toEqual([]);
        expect(check(wa({ event: 'order_created' }, { id: 'n', type: 'add_note', config: { text: 'Refunded {{refund.amount}}' } }))).toEqual(['unknown_variable']);
        expect(codes([{ id: 't', type: 'trigger', config: { channel: 'instagram', event: 'order_refunded' } }, { id: 'n', type: 'add_note', config: { text: 'x' } }])).toContain('event_unavailable');
    });

    it('sends a slot without a chosen template, with the values its own wording needs', () => {
        expect(check(wa({ event: 'order_fulfilled' }, slot('order_shipped')))).toEqual([]);
        expect(check(wa({ event: 'checkout_abandoned' }, slot('cart_reminder_3')))).toEqual([]);
        expect(check(wa({ event: 'website_signup' }, slot('optin_confirmed')))).toEqual([]);
        expect(check(wa({ event: 'order_refunded' }, slot('refund_processed')))).toEqual([]);
        // Out of place: the order a shipping update reads is not there.
        expect(check(wa({ event: 'website_signup' }, slot('order_shipped')))).toContain('unknown_variable');
        expect(check(wa({ event: 'order_created' }, slot('no_such_slot')))).toEqual(['template_slot_unknown']);
        expect(check(wa({ event: 'website_signup' }, slot('gst_invoice')))).toContain('invoice_needs_order');
        // A chosen template wins over the slot, and is checked as before.
        expect(check(wa({ event: 'order_created' }, slot('order_confirmed', { templateId: 'tpl_gone' })))).toEqual(['template_not_found']);
    });

    it('knows the store’s name, the tapped payload and, on carts, the discount', () => {
        const note = (text: string) => ({ id: 'n', type: 'add_note', config: { text } });
        expect(check(wa({ event: 'message', match: 'any' }, note('{{store.name}} {{last_reply_payload}} {{first_name|there}}')))).toEqual([]);
        expect(check(wa({ event: 'checkout_abandoned' }, note('{{cart.discount_code}} {{cart.discount_text}} {{cart.discount_expiry}} {{checkout.cart_path}}')))).toEqual([]);
        expect(check(wa({ event: 'order_created' }, note('{{cart.discount_code}}')))).toEqual(['unknown_variable']);
        expect(check(wa({ event: 'order_created' }, note('{{order.track_path}}')))).toEqual([]);
    });

    it('reads stop conditions, till sales, order age, one run at a time and WhatsApp Pay orders from the trigger, and older versions unchanged', () => {
        const [plain] = parseDefinition({ steps: wa({ event: 'order_created' }) });
        expect(plain.config).not.toHaveProperty('stopWhen');
        expect(plain.config).not.toHaveProperty('skipPos');
        expect(plain.config).not.toHaveProperty('orderWithinDays');
        expect(plain.config).not.toHaveProperty('oneRunAtATime');
        expect(plain.config).not.toHaveProperty('skipWhatsAppPay');
        expect(triggerConfigFor(plain)).toEqual({ match: 'contains', newConversationOnly: false, phoneField: 'phone' });
        const [full] = parseDefinition({
            steps: wa({ event: 'invoice_issued', skipPos: true, orderWithinDays: 3, stopWhen: { orderPlaced: true, replied: false, unknown: 1 } }),
        });
        expect(full.config.stopWhen).toEqual({ orderPlaced: true, replied: false });
        expect(triggerConfigFor(full)).toEqual({ match: 'contains', newConversationOnly: false, phoneField: 'phone', skipPos: true, orderWithinDays: 3 });
        const [cart] = parseDefinition({ steps: wa({ event: 'checkout_abandoned', oneRunAtATime: true }) });
        expect(triggerConfigFor(cart)).toEqual({ match: 'contains', newConversationOnly: false, phoneField: 'phone', oneRunAtATime: true });
        const [shipped] = parseDefinition({ steps: wa({ event: 'order_fulfilled', skipWhatsAppPay: true }) });
        expect(triggerConfigFor(shipped)).toEqual({ match: 'contains', newConversationOnly: false, phoneField: 'phone', skipWhatsAppPay: true });
        expect(() => parseDefinition({ steps: wa({ event: 'order_fulfilled', skipWhatsAppPay: 'yes' }) })).toThrow(BadRequestException);
        expect(() => parseDefinition({ steps: wa({ event: 'invoice_issued', orderWithinDays: 0 }) })).toThrow(BadRequestException);
    });

    it('takes a slot on “Send the invoice” and “Send a payment link” too, with no template to choose', () => {
        expect(check(wa({ event: 'invoice_issued' }, { id: 'i', type: 'send_invoice', config: { templateSlot: 'gst_invoice' } }))).toEqual([]);
        expect(check(wa({ event: 'invoice_issued' }, { id: 'i', type: 'send_invoice', config: { templateSlot: 'order_shipped' } }))).toEqual(['template_needs_document']);
        expect(check(wa({ event: 'invoice_issued' }, { id: 'i', type: 'send_invoice', config: { templateSlot: 'gone' } }))).toEqual(['template_slot_unknown']);
        const pay = (templateSlot: string) => collectIssues(parseDefinition({ steps: wa({ event: 'order_created' }, { id: 'p', type: 'send_payment_link', config: { kind: 'template', templateSlot } }) }), {
            platform: 'WHATSAPP', knownMediaIds: null, templates: new Map(), paymentsConnected: true,
        }).map((i) => i.code);
        expect(pay('payment_link')).toEqual([]);
        expect(pay('pay_online')).toEqual([]);
        expect(pay('order_shipped')).toEqual(['payment_link_unused']);
        expect(pay('gst_invoice')).toEqual(['template_header_unsupported']);
    });

    it('matches on a tapped button’s payload', () => {
        const condition = { id: 'c', type: 'condition', config: { rules: [{ field: 'reply_payload', op: 'equals', value: 'collabo_cod_confirm' }] } };
        expect(check(wa({ event: 'order_created' }, condition))).toEqual([]);
    });
});
