import { toMetaComponents } from '../../campaigns/templates/template-components';
import { templatePack, type CollaboVariant } from '../../campaigns/templates/pack/template-pack';
import { AutomationRunner } from './automation-runner.service';

/**
 * Template steps that name a slot of the recommended pack, the holds that
 * park a run and run the same step again (quiet hours, a paused template),
 * skipped sends, and the trigger's stop conditions.
 */

type Row = Record<string, any>;
const APP = 'https://app.example.com';
const pack = templatePack(APP);

/** A zone where the hour is `hour` right now, so quiet hours can be tested at any time of day. */
function zoneAt(hour: number): string {
    let offset = (hour - new Date().getUTCHours() + 24) % 24;
    if (offset > 14) offset -= 24;
    return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

/** A pack template row as the pack would have created it from Collabo's wording. */
function collaboTemplate(slotKey: string, over: Row = {}): Row {
    const slot = pack.find((s) => s.key === slotKey)!;
    const variant = slot.variants.find((v) => v.source === 'collabo') as CollaboVariant;
    const name = `collabo_${slotKey}_v1`;
    return {
        id: `tpl_${slotKey}`,
        organizationId: 'o',
        wabaId: 'waba1',
        name,
        language: 'en',
        category: slot.category,
        status: 'APPROVED',
        parameterFormat: 'NAMED',
        components: toMetaComponents({ ...variant.draft, name, language: 'en', category: slot.category } as never, 'h'),
        packSlot: slotKey,
        packVersion: 1,
        packSource: 'collabo',
        libraryTemplateName: null,
        updatedAt: new Date(),
        ...over,
    };
}

function harness(opts: {
    steps: Row[];
    templates?: Row[];
    timeZone?: string;
    run?: Row;
    contact?: Row;
    order?: Row | null;
    event?: Row | null;
    checkout?: Row | null;
    laterOrder?: boolean;
    inbound?: boolean;
    discount?: Row | null;
    invoice?: boolean;
}) {
    const run: Row = {
        id: 'run1',
        organizationId: 'o',
        automationId: 'a1',
        automationVersionId: 'v1',
        eventId: 'evt1',
        contactId: 'c1',
        customerId: null,
        orderId: opts.order === null ? null : 'ord1',
        startedAt: null,
        createdAt: new Date(Date.now() - 60_000),
        currentStepKey: null,
        context: { vars: { 'order.name': '#1042', 'order.total': '₹2,499.00', 'order.track_path': 'ord1.sig' }, trigger: { eventType: 'crm.order.created', commentId: null, postId: null }, depth: 0 },
        version: { definition: { steps: opts.steps } },
        automation: { id: 'a1', status: 'ACTIVE', ownerUserId: null },
        ...opts.run,
    };
    const steps: Row[] = [];
    const runUpdates: Row[] = [];
    const prisma = {
        automationRun: {
            updateMany: jest.fn(async () => ({ count: 1 })),
            findUniqueOrThrow: jest.fn(async () => run),
            update: jest.fn(async ({ data }: Row) => {
                runUpdates.push(data);
                Object.assign(run, data);
                return run;
            }),
        },
        automationRunStep: {
            upsert: jest.fn(async ({ where, create, update }: Row) => {
                const key = where.runId_stepKey_attempt.stepKey;
                const at = steps.findIndex((s) => s.stepKey === key);
                if (at >= 0) Object.assign(steps[at], update);
                else steps.push({ ...create });
            }),
            updateMany: jest.fn(async ({ where, data }: Row) => {
                for (const s of steps) if (s.stepKey === where.stepKey) Object.assign(s, data);
                return { count: 1 };
            }),
        },
        automation: { update: jest.fn(async () => ({})) },
        organization: { findUnique: jest.fn(async () => ({ name: 'Acme Org', timezone: opts.timeZone ?? zoneAt(12), settings: { storeProfileSettings: { storeName: 'Acme Store' } } })) },
        channel: { findFirst: jest.fn(async () => ({ externalStoreId: 'waba1' })) },
        templatePack: { findUnique: jest.fn(async () => ({ organizationId: 'o', settings: opts.discount ? { cartDiscount: opts.discount } : {} })) },
        messageTemplate: {
            findMany: jest.fn(async ({ where }: Row) => (opts.templates ?? []).filter((t) => t.packSlot === where.packSlot && t.wabaId === where.wabaId)),
            findFirst: jest.fn(async ({ where }: Row) => (opts.templates ?? []).find((t) => t.id === where.id) ?? null),
        },
        channelContact: {
            findUnique: jest.fn(async ({ select }: Row) =>
                select
                    ? { optedOutAt: null, customerId: null, ...opts.contact }
                    : { id: 'c1', channelId: 'ch1', platform: 'WHATSAPP', name: null, displayName: null, addressBookName: null, username: null, phone: '+919800000000', tags: [], attributes: {}, optInAt: null, optedOutAt: null, customerId: null, customer: null, ...opts.contact },
            ),
        },
        conversation: { findUnique: jest.fn(async () => ({ id: 'conv1', assignedUserId: null, platform: 'WHATSAPP', lastInboundAt: null })) },
        order: {
            findUnique: jest.fn(async () => opts.order ?? { paymentGateways: [], totalPrice: 2499, posSale: false, sourceName: 'web' }),
            findFirst: jest.fn(async () => (opts.laterOrder ? { id: 'ord2' } : null)),
        },
        message: { findFirst: jest.fn(async ({ where }: Row) => (opts.inbound && !where.id?.notIn?.includes('in1') ? { id: 'in1' } : null)) },
        automationEvent: {
            findUnique: jest.fn(async () => opts.event ?? null),
            findMany: jest.fn(async ({ where }: Row) => where.id.in.map((id: string) => ({ messageId: id === 'evt_reply' ? 'in1' : null }))),
        },
        checkout: { findUnique: jest.fn(async () => opts.checkout ?? null) },
        $transaction: jest.fn(async (ops: unknown) => (Array.isArray(ops) ? Promise.all(ops) : undefined)),
    };
    const sent: Row[] = [];
    const sender = {
        send: jest.fn(async (input: Row) => {
            sent.push(input);
            return { ok: true, messageId: `msg${sent.length}` };
        }),
        conversationFor: jest.fn(async () => 'conv1'),
    };
    const jobs = { resume: jest.fn(), event: jest.fn(), run: jest.fn() };
    const store = {
        invoiceDocument: jest.fn(async () =>
            opts.invoice ? { invoiceId: 'inv1', storageKey: 'o/inv.pdf', filename: 'INV-1.pdf', vars: { 'invoice.number': 'INV-1', 'invoice.date': '26 Oct 2026', 'invoice.total': '₹2,499.00' } } : null,
        ),
        actorFor: jest.fn(async () => 'u1'),
        tagOrder: jest.fn(async () => ({ tags: ['x'] })),
    };
    const paymentLinks = {
        forOrder: jest.fn(async () => ({ id: 'pl1', shortUrl: 'https://rzp.io/rzp/T1x', amount: 2499, currency: 'INR', expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() })),
    };
    const none = {} as never;
    const config = { get: (key: string) => (key === 'frontendUrl' ? APP : undefined) };
    const runner = new AutomationRunner(prisma as never, sender as never, jobs as never, none, { publish: jest.fn() } as never, none, none, store as never, paymentLinks as never, none, none, none, config as never);
    jest.spyOn((runner as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    return { runner, run, prisma, sent, steps, runUpdates, jobs, store, paymentLinks, sender };
}

const trigger = (event = 'order_created', extra: Row = {}) => ({ id: 't', type: 'trigger', config: { channel: 'whatsapp', event, ...extra } });
const slotStep = (id: string, templateSlot: string) => ({ id, type: 'send_message', config: { kind: 'template', templateSlot } });
const note = { id: 'n', type: 'add_note', config: { text: 'after' } };

describe('AutomationRunner — a template step that names a pack slot', () => {
    it('sends the account’s approved template, filled from the pack, with its quick-reply payloads', async () => {
        const h = harness({ steps: [trigger(), slotStep('s', 'cod_confirm')], templates: [collaboTemplate('cod_confirm')] });
        await h.runner.run('run1');
        expect(h.sent).toHaveLength(1);
        const payload = h.sent[0].payload;
        expect(payload).toMatchObject({ type: 'template', name: 'collabo_cod_confirm_v1', language: 'en', category: 'UTILITY' });
        expect(payload.components).toEqual([
            {
                type: 'body',
                parameters: [
                    { type: 'text', parameter_name: 'first_name', text: 'there' },
                    { type: 'text', parameter_name: 'order_number', text: '#1042' },
                    { type: 'text', parameter_name: 'order_total', text: '₹2,499.00' },
                ],
            },
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'collabo_cod_confirm' }] },
            { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'collabo_cod_cancel' }] },
        ]);
        expect(h.sent[0].idempotencyKey).toBe('auto:run1:s');
        expect(h.run.status).toBe('COMPLETED');
    });

    it('prefers the newest approved version, and fills a library template’s numbered parameters', async () => {
        const library = {
            ...collaboTemplate('order_confirmed', { id: 'tpl_lib', name: 'collabo_order_confirmed_v2', packVersion: 2, packSource: 'library', libraryTemplateName: 'order_confirmed', parameterFormat: 'POSITIONAL' }),
            components: [{ type: 'HEADER', format: 'TEXT', text: 'Order confirmed' }, { type: 'BODY', text: 'Hi {{1}}, We are getting your order {{2}} ready.' }],
        };
        const h = harness({ steps: [trigger(), slotStep('s', 'order_confirmed')], templates: [collaboTemplate('order_confirmed'), library], contact: { customer: { firstName: 'Meera', lastName: null, ordersCount: 1, tags: [] } } });
        await h.runner.run('run1');
        expect(h.sent[0].payload.name).toBe('collabo_order_confirmed_v2');
        expect(h.sent[0].payload.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Meera' }, { type: 'text', text: '#1042' }] }]);
    });

    it('fills {{store.name}} from the store profile, and attaches the invoice PDF for the invoice slot', async () => {
        const optin = harness({ steps: [trigger('website_signup'), slotStep('s', 'optin_confirmed')], templates: [collaboTemplate('optin_confirmed')], order: null });
        await optin.runner.run('run1');
        expect(optin.sent[0].payload.components[0].parameters.map((p: Row) => p.text)).toEqual(['there', 'Acme Store']);

        const invoice = harness({ steps: [trigger('invoice_issued'), slotStep('s', 'gst_invoice')], templates: [collaboTemplate('gst_invoice')], invoice: true });
        await invoice.runner.run('run1');
        expect(invoice.sent[0].payload.headerMedia).toEqual({ storageKey: 'o/inv.pdf', mime: 'application/pdf', kind: 'document', filename: 'INV-1.pdf' });
        expect(invoice.sent[0].payload.components[1].parameters.map((p: Row) => p.text)).toEqual(['there', '#1042', 'INV-1', '₹2,499.00']);
    });

    it('skips the step, never fails the run, when nothing can be sent', async () => {
        const cases = [
            harness({ steps: [trigger(), slotStep('s', 'order_confirmed'), note], templates: [collaboTemplate('order_confirmed', { status: 'PENDING' })] }),
            harness({ steps: [trigger(), slotStep('s', 'order_confirmed'), note], templates: [collaboTemplate('order_confirmed', { status: 'REJECTED' })] }),
            harness({ steps: [trigger(), slotStep('s', 'no_such_slot'), note] }),
            harness({ steps: [trigger('invoice_issued'), slotStep('s', 'gst_invoice'), note], templates: [collaboTemplate('gst_invoice')], invoice: false }),
        ];
        for (const h of cases) {
            (h.prisma as Row).conversationNote = { create: jest.fn(async () => ({ id: 'note1' })) };
            await h.runner.run('run1');
            expect(h.sent).toHaveLength(0);
            expect(h.steps.find((s) => s.stepKey === 's')).toMatchObject({ status: 'SKIPPED' });
            expect(h.steps.find((s) => s.stepKey === 'n')).toMatchObject({ status: 'COMPLETED' });
            expect(h.run.status).toBe('COMPLETED');
        }
        expect(cases[0].steps[0].output).toMatchObject({ skipped: 'template_unavailable', status: 'PENDING' });
        expect(cases[3].steps[0].output).toMatchObject({ skipped: 'invoice_missing' });
    });

    it('skips a send whose value is empty, rather than sending it half filled', async () => {
        const h = harness({
            steps: [trigger('checkout_abandoned'), slotStep('s', 'cart_reminder_3')],
            templates: [collaboTemplate('cart_reminder_3')],
            run: { context: { vars: { 'checkout.cart_path': 'chk1.sig' }, trigger: { eventType: 'crm.checkout.abandoned', commentId: null, postId: null }, depth: 0 } },
            order: null,
            discount: null,
        });
        await h.runner.run('run1');
        expect(h.sent).toHaveLength(0);
        expect(h.steps[0]).toMatchObject({ status: 'SKIPPED', output: expect.objectContaining({ skipped: 'value_missing' }) });
    });

    it('offers the pack’s cart discount, valid for its days in the store’s time zone', async () => {
        const h = harness({
            steps: [trigger('checkout_abandoned'), slotStep('s', 'cart_reminder_3')],
            templates: [collaboTemplate('cart_reminder_3', { category: 'MARKETING' })],
            run: { context: { vars: { 'checkout.cart_path': 'chk1.sig' }, trigger: { eventType: 'crm.checkout.abandoned', commentId: null, postId: null }, depth: 0 } },
            order: null,
            discount: { code: 'SAVE10', text: '10%', validDays: 7 },
            timeZone: zoneAt(12),
        });
        await h.runner.run('run1');
        const expiry = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: zoneAt(12) });
        expect(h.sent[0].payload.components).toEqual([
            {
                type: 'body',
                parameters: [
                    { type: 'text', parameter_name: 'first_name', text: 'there' },
                    { type: 'text', parameter_name: 'discount', text: '10%' },
                    { type: 'text', parameter_name: 'expiry', text: expiry },
                ],
            },
            { type: 'button', sub_type: 'copy_code', index: 0, parameters: [{ type: 'coupon_code', coupon_code: 'SAVE10' }] },
            { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'chk1.sig' }] },
        ]);
    });
});

describe('AutomationRunner — holding a send back', () => {
    it('holds a send while Meta pauses the template, retrying every 30 minutes for 12 hours, then skips it', async () => {
        const paused = [collaboTemplate('order_shipped', { status: 'PAUSED' })];
        const h = harness({ steps: [trigger('order_fulfilled'), slotStep('s', 'order_shipped'), note], templates: paused });
        await h.runner.run('run1');
        expect(h.sent).toHaveLength(0);
        expect(h.run).toMatchObject({ status: 'WAITING', waitingForReply: false, context: expect.objectContaining({ hold: { stepId: 's', reason: 'template_paused' } }) });
        const retryIn = h.run.resumeAt.getTime() - Date.now();
        expect(retryIn).toBeGreaterThan(29 * 60_000);
        expect(retryIn).toBeLessThanOrEqual(30 * 60_000);
        expect(h.jobs.resume).toHaveBeenCalledWith('run1', 'timer', h.run.resumeAt);
        expect(h.steps[0]).toMatchObject({ status: 'WAITING', finishedAt: null });

        const late = harness({ steps: [trigger('order_fulfilled'), slotStep('s', 'order_shipped'), note], templates: paused, run: { createdAt: new Date(Date.now() - 13 * 3600_000) } });
        (late.prisma as Row).conversationNote = { create: jest.fn(async () => ({ id: 'note1' })) };
        await late.runner.run('run1');
        expect(late.steps[0]).toMatchObject({ status: 'SKIPPED', output: expect.objectContaining({ skipped: 'template_unavailable', status: 'PAUSED' }) });
        expect(late.run.status).toBe('COMPLETED');
    });

    it('holds marketing between 21:00 and 09:00 store time, without a message row, and sends it on waking', async () => {
        const reminder = [collaboTemplate('cart_reminder_1', { category: 'MARKETING' })];
        const cartRun = { context: { vars: { 'checkout.items': 'Linen shirt', 'checkout.total': '₹1,199.00', 'checkout.cart_path': 'chk1.sig' }, trigger: { eventType: 'crm.checkout.abandoned', commentId: null, postId: null }, depth: 0 } };
        const h = harness({ steps: [trigger('checkout_abandoned'), slotStep('s', 'cart_reminder_1')], templates: reminder, timeZone: zoneAt(23), run: cartRun, order: null });
        await h.runner.run('run1');
        expect(h.sent).toHaveLength(0);
        expect(h.run.status).toBe('WAITING');
        expect(h.run.context.hold).toEqual({ stepId: 's', reason: 'quiet_hours' });
        const until = h.run.resumeAt.getTime() - Date.now();
        expect(until).toBeGreaterThan(9 * 3600_000); // 23:xx → 09:00 is at least 9 hours away
        expect(until).toBeLessThanOrEqual(10 * 3600_000);

        // Morning: the same step runs again, rather than the one after it.
        (h.prisma.organization.findUnique as jest.Mock).mockResolvedValue({ name: 'Acme', timezone: zoneAt(10), settings: null });
        h.run.resumeAt = new Date(Date.now() - 1000);
        await h.runner.resume('run1', 'timer');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0].payload.name).toBe('collabo_cart_reminder_1_v1');
        expect(h.run.status).toBe('COMPLETED');
        expect(h.run.context.hold).toBeUndefined();
        expect(h.steps[0]).toMatchObject({ status: 'COMPLETED', messageId: 'msg1' });
    });

    it('holds a merchant’s own marketing template the same way, but never utility', async () => {
        const mine = (category: string) => ({ ...collaboTemplate('order_confirmed', { id: 'tpl_mine', name: 'my_offer', category, packSlot: null }) });
        const step = { id: 's', type: 'send_message', config: { kind: 'template', templateId: 'tpl_mine', templateValues: { 'body.first_name': '{{first_name|there}}', 'body.order_number': 'x', 'body.order_total': 'y' } } };
        const marketing = harness({ steps: [trigger(), step], templates: [mine('MARKETING')], timeZone: zoneAt(2) });
        await marketing.runner.run('run1');
        expect([marketing.sent.length, marketing.run.status, marketing.run.context.hold?.reason]).toEqual([0, 'WAITING', 'quiet_hours']);
        const utility = harness({ steps: [trigger(), step], templates: [mine('UTILITY')], timeZone: zoneAt(2) });
        await utility.runner.run('run1');
        expect([utility.sent.length, utility.run.status]).toEqual([1, 'COMPLETED']);
    });
});

describe('AutomationRunner — stop conditions', () => {
    const cartSteps = (stopWhen: Row) => [
        trigger('checkout_abandoned', { stopWhen }),
        { id: 'w', type: 'wait', config: { amount: 4, unit: 'hours' } },
        slotStep('s2', 'cart_reminder_2'),
    ];
    const waiting = (over: Row = {}) => ({
        status: 'WAITING',
        currentStepKey: 'w',
        startedAt: new Date(Date.now() - 5 * 3600_000),
        resumeAt: new Date(Date.now() - 1000),
        context: { vars: { 'checkout.cart_path': 'chk1.sig' }, trigger: { eventType: 'crm.checkout.abandoned', commentId: null, postId: null }, depth: 0 },
        ...over,
    });
    const reminder = [collaboTemplate('cart_reminder_2', { category: 'UTILITY' })];

    it('ends the run as completed, with why, when its checkout was completed', async () => {
        const h = harness({
            steps: cartSteps({ orderPlaced: true }),
            templates: reminder,
            run: waiting(),
            order: null,
            event: { payload: { raw: { checkoutId: 'chk1' } } },
            checkout: { completedAt: new Date() },
        });
        h.steps.push({ stepKey: 'w', status: 'WAITING' });
        await h.runner.resume('run1', 'timer');
        expect(h.sent).toHaveLength(0);
        expect(h.run).toMatchObject({ status: 'COMPLETED', skipReason: 'order_placed', currentStepKey: null });
        expect(h.steps[0]).toMatchObject({ status: 'COMPLETED', output: { stopped: 'order_placed' } });
        expect(h.prisma.checkout.findUnique).toHaveBeenCalledWith({ where: { id: 'chk1' }, select: { completedAt: true } });
    });

    it('stops when the shopper ordered another way, wrote in, or opted out since the run started', async () => {
        const ordered = harness({ steps: cartSteps({ orderPlaced: true }), templates: reminder, run: waiting({ customerId: 'cust1' }), order: null, laterOrder: true });
        await ordered.runner.resume('run1', 'timer');
        expect(ordered.run.skipReason).toBe('order_placed');

        const wrote = harness({ steps: cartSteps({ replied: true }), templates: reminder, run: waiting(), order: null, inbound: true });
        await wrote.runner.resume('run1', 'timer');
        expect(wrote.run.skipReason).toBe('replied');
        expect(wrote.prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ direction: 'INBOUND', imported: false }) }));

        const optedOut = harness({ steps: cartSteps({ optedOut: true }), templates: reminder, run: waiting(), order: null, contact: { optedOutAt: new Date() } });
        await optedOut.runner.resume('run1', 'timer');
        expect(optedOut.run.skipReason).toBe('opted_out');

        for (const h of [ordered, wrote, optedOut]) expect([h.sent.length, h.run.status]).toEqual([0, 'COMPLETED']);
    });

    it('carries on when nothing happened, and without stop conditions never looks', async () => {
        const quiet = harness({ steps: cartSteps({ orderPlaced: true, replied: true, optedOut: true }), templates: reminder, run: waiting(), order: null, event: { payload: { raw: { checkoutId: 'chk1' } } }, checkout: { completedAt: null } });
        await quiet.runner.resume('run1', 'timer');
        expect(quiet.sent.map((s) => s.payload.name)).toEqual(['collabo_cart_reminder_2_v1']);
        expect(quiet.run.skipReason).toBeUndefined();

        const plain = harness({ steps: cartSteps({}), templates: reminder, run: waiting(), order: null, inbound: true, laterOrder: true });
        await plain.runner.resume('run1', 'timer');
        expect(plain.sent).toHaveLength(1);
        expect(plain.prisma.message.findFirst).not.toHaveBeenCalled();
    });

    it('does not count the reply a wait-for-reply step was waiting for', async () => {
        const steps = [
            trigger('order_created', { stopWhen: { replied: true } }),
            { id: 'w', type: 'wait_for_reply', config: { amount: 3, unit: 'hours' }, branches: { replied: [note], timeout: [] } },
        ];
        const h = harness({ steps, run: waiting({ context: { vars: { last_reply: 'Confirm order' }, replied: true, trigger: { eventType: 'crm.order.created', commentId: null, postId: null }, depth: 0 } }), inbound: true });
        (h.prisma as Row).conversationNote = { create: jest.fn(async () => ({ id: 'note1' })) };
        await h.runner.resume('run1', 'reply');
        expect(h.run.skipReason).toBeUndefined();
        expect(h.steps.find((s) => s.stepKey === 'n')).toMatchObject({ status: 'COMPLETED' });
    });

    it('stops a held send too, and records it as never sent', async () => {
        const h = harness({
            steps: [trigger('checkout_abandoned', { stopWhen: { orderPlaced: true } }), slotStep('s', 'cart_reminder_1')],
            run: waiting({ currentStepKey: 's', context: { vars: {}, trigger: { eventType: 'crm.checkout.abandoned', commentId: null, postId: null }, depth: 0, hold: { stepId: 's', reason: 'quiet_hours' } } }),
            order: null,
            event: { payload: { raw: { checkoutId: 'chk1' } } },
            checkout: { completedAt: new Date() },
        });
        h.steps.push({ stepKey: 's', status: 'WAITING' });
        await h.runner.resume('run1', 'timer');
        expect(h.sent).toHaveLength(0);
        expect(h.steps[0]).toMatchObject({ status: 'SKIPPED', output: { stopped: 'order_placed' } });
        expect(h.run.context.hold).toBeUndefined();
    });
});

describe('AutomationRunner — pack slots on the invoice and payment-link steps', () => {
    it('“Send the invoice” sends the invoice slot with the order’s PDF, and skips a slot without a document', async () => {
        const invoice = harness({ steps: [trigger('invoice_issued'), { id: 's', type: 'send_invoice', config: { templateSlot: 'gst_invoice' } }], templates: [collaboTemplate('gst_invoice')], invoice: true });
        await invoice.runner.run('run1');
        expect(invoice.sent[0].payload).toMatchObject({ name: 'collabo_gst_invoice_v1', headerMedia: { kind: 'document', filename: 'INV-1.pdf' } });

        const wrong = harness({ steps: [trigger('invoice_issued'), { id: 's', type: 'send_invoice', config: { templateSlot: 'order_shipped' } }], templates: [collaboTemplate('order_shipped')], invoice: true });
        await wrong.runner.run('run1');
        expect(wrong.sent).toHaveLength(0);
        expect(wrong.steps[0]).toMatchObject({ status: 'SKIPPED', output: expect.objectContaining({ skipped: 'template_unavailable' }) });
        expect(wrong.store.invoiceDocument).not.toHaveBeenCalled();
    });

    it('“Send a payment link” makes the link only once the slot has a template, and puts it in the button', async () => {
        const step = { id: 's', type: 'send_payment_link', config: { kind: 'template', templateSlot: 'payment_link' } };
        const h = harness({ steps: [trigger(), step], templates: [collaboTemplate('payment_link')] });
        await h.runner.run('run1');
        expect(h.paymentLinks.forOrder).toHaveBeenCalledTimes(1);
        expect(h.sent[0].payload.name).toBe('collabo_payment_link_v1');
        expect(h.sent[0].payload.components[1]).toEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'rzp/T1x' }] });

        const none = harness({ steps: [trigger(), step], templates: [collaboTemplate('payment_link', { status: 'PENDING' })] });
        await none.runner.run('run1');
        expect(none.paymentLinks.forOrder).not.toHaveBeenCalled();
        expect(none.steps[0]).toMatchObject({ status: 'SKIPPED', output: expect.objectContaining({ skipped: 'template_unavailable' }) });
    });
});

describe('AutomationRunner — people who stopped promotions', () => {
    const cartRun = { context: { vars: { 'checkout.items': 'Linen shirt', 'checkout.total': '₹1,199.00', 'checkout.cart_path': 'chk1.sig' }, trigger: { eventType: 'crm.checkout.abandoned', commentId: null, postId: null }, depth: 0 } };

    it('skips a marketing slot for them, at once rather than after the night, and the run carries on', async () => {
        const h = harness({
            steps: [trigger('checkout_abandoned'), slotStep('s', 'cart_reminder_1'), note],
            templates: [collaboTemplate('cart_reminder_1', { category: 'MARKETING' })],
            run: cartRun,
            order: null,
            timeZone: zoneAt(23),
            contact: { optedOutAt: new Date(Date.now() - 86_400_000) },
        });
        (h.prisma as Row).conversationNote = { create: jest.fn(async () => ({ id: 'note1' })) };
        await h.runner.run('run1');
        expect(h.sent).toHaveLength(0);
        expect(h.steps[0]).toMatchObject({ status: 'SKIPPED', output: expect.objectContaining({ skipped: 'opted_out' }) });
        expect(h.run.status).toBe('COMPLETED');
    });

    it('turns the send gate’s refusal into a skip on a slot step, not a failed run', async () => {
        const h = harness({ steps: [trigger(), slotStep('s', 'order_confirmed')], templates: [collaboTemplate('order_confirmed')] });
        h.sender.send.mockResolvedValueOnce({ ok: false, code: 'opted_out', message: 'This customer opted out of marketing messages.' } as never);
        await h.runner.run('run1');
        expect(h.steps[0]).toMatchObject({ status: 'SKIPPED', output: { skipped: 'opted_out' } });
        expect([h.run.status, h.prisma.automation.update.mock.calls.length]).toEqual(['COMPLETED', 0]);
    });
});

describe('AutomationRunner — stop conditions, again', () => {
    it('does not count, at a later wake-up, the reply a wait-for-reply step already took', async () => {
        const steps = [
            trigger('order_created', { stopWhen: { replied: true } }),
            { id: 'r', type: 'wait_for_reply', config: { amount: 3, unit: 'hours' }, branches: { replied: [], timeout: [] } },
            { id: 'w', type: 'wait', config: { amount: 1, unit: 'hours' } },
            note,
        ];
        const h = harness({
            steps,
            inbound: true,
            run: {
                status: 'WAITING', currentStepKey: 'w', startedAt: new Date(Date.now() - 5 * 3600_000), resumeAt: new Date(Date.now() - 1000),
                context: { vars: { last_reply: 'Confirm order' }, replyEventIds: ['evt_reply'], trigger: { eventType: 'crm.order.created', commentId: null, postId: null }, depth: 0 },
            },
        });
        (h.prisma as Row).conversationNote = { create: jest.fn(async () => ({ id: 'note1' })) };
        await h.runner.resume('run1', 'timer');
        expect(h.prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { notIn: ['in1'] } }) }));
        expect(h.run.skipReason).toBeUndefined();
        expect(h.steps.find((s) => s.stepKey === 'n')).toMatchObject({ status: 'COMPLETED' });
    });

    it('checks them when a held send is picked up after its worker died', async () => {
        const h = harness({
            steps: [trigger('checkout_abandoned', { stopWhen: { orderPlaced: true } }), slotStep('s', 'cart_reminder_1')],
            templates: [collaboTemplate('cart_reminder_1', { category: 'MARKETING' })],
            run: {
                status: 'RUNNING', currentStepKey: 's', startedAt: new Date(Date.now() - 3600_000),
                context: { vars: {}, trigger: { eventType: 'crm.checkout.abandoned', commentId: null, postId: null }, depth: 0, hold: { stepId: 's', reason: 'quiet_hours' } },
            },
            order: null,
            event: { payload: { raw: { checkoutId: 'chk1' } } },
            checkout: { completedAt: new Date() },
        });
        h.steps.push({ stepKey: 's', status: 'WAITING' });
        await h.runner.run('run1');
        expect(h.sent).toHaveLength(0);
        expect(h.run).toMatchObject({ status: 'COMPLETED', skipReason: 'order_placed' });
    });
});
