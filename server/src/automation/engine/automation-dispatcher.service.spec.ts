import { AutomationDispatcher } from './automation-dispatcher.service';

type Row = Record<string, any>;

/** Redis's SET NX and compare-and-delete, in memory. */
function fakeRedis() {
    const held = new Map<string, string>();
    return {
        runScript: jest.fn(async (name: string, _lua: string, _keys: number, [key]: string[], [token]: unknown[]) => {
            if (name === 'lockAcquire') {
                if (held.has(key)) return null;
                held.set(key, String(token));
                return 'OK';
            }
            if (held.get(key) !== String(token)) return 0;
            held.delete(key);
            return 1;
        }),
    };
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, s));

const event = (over: Row = {}): Row => ({
    id: 'e1',
    organizationId: 'o',
    channelId: 'ch',
    eventType: 'whatsapp.message',
    externalId: 'wamid.1',
    occurredAt: at(0),
    createdAt: at(1),
    contactId: 'c1',
    customerId: null,
    orderId: null,
    mediaId: null,
    messageId: null,
    actorExternalId: null,
    actorUsername: null,
    text: 'hi',
    payload: { raw: {} },
    processedAt: null,
    matchedRuns: 0,
    error: null,
    ...over,
});

const trigger = (id: string, over: Row = {}, once: string = 'ever'): Row => ({
    id,
    organizationId: 'o',
    automationId: `a-${id}`,
    position: 0,
    channelId: 'ch',
    triggerType: 'whatsapp.message',
    mediaId: null,
    subjectId: null,
    keywords: [],
    config: { match: 'any' },
    isActive: true,
    automation: { id: `a-${id}`, status: 'ACTIVE', publishedVersionId: `v-${id}`, publishedAt: at(0), publishedVersion: { settings: { oncePerContact: once } } },
    ...over,
});

function harness(opts: { events: Row[]; triggers?: Row[]; ranBefore?: string[]; waiting?: Row | null; order?: Row | null }) {
    const events = new Map(opts.events.map((e) => [e.id, e]));
    const ranBefore = new Set(opts.ranBefore ?? []);
    const created: Row[] = [];
    const processed: string[] = [];
    let busy = 0;
    let maxBusy = 0;
    const prisma = {
        automationEvent: {
            findUnique: jest.fn(async ({ where }: Row) => (events.has(where.id) ? { ...events.get(where.id) } : null)),
            findMany: jest.fn(async ({ where }: Row) =>
                [...events.values()]
                    .filter((e) => e.contactId === where.contactId && e.id !== where.id.not && !e.processedAt && !e.error)
                    .filter((e) => where.OR.some((c: Row) => (c.createdAt ? +e.occurredAt === +c.occurredAt && e.createdAt < c.createdAt.lt : e.occurredAt < c.occurredAt.lt)))
                    .sort((a, b) => +a.occurredAt - +b.occurredAt || +a.createdAt - +b.createdAt),
            ),
            update: jest.fn(async ({ where, data }: Row) => {
                Object.assign(events.get(where.id)!, data);
                if (data.processedAt) processed.push(where.id);
                return {};
            }),
        },
        automationTrigger: { findMany: jest.fn(async ({ where }: Row) => (opts.triggers ?? []).filter((t) => t.triggerType === where.triggerType)) },
        automationRun: {
            findFirst: jest.fn(async ({ where }: Row) => {
                if (where.context) return null;
                if (where.waitingForReply) return opts.waiting ?? null;
                const ran = ranBefore.has(where.automationId) || created.some((r) => r.automationId === where.automationId && r.status !== 'SKIPPED');
                return ran ? { id: 'earlier' } : null;
            }),
            create: jest.fn(async ({ data }: Row) => {
                created.push(data);
                return { id: `run-${created.length}` };
            }),
            updateMany: jest.fn(async () => ({ count: 1 })),
        },
        channelContact: { findUnique: jest.fn(async () => ({ customerId: null, attributes: {} })), update: jest.fn() },
        automation: { update: jest.fn(async () => ({})) },
        message: { findUnique: jest.fn(async () => null) },
        order: { findUnique: jest.fn(async () => opts.order ?? null) },
    };
    const jobs = { run: jest.fn(), resume: jest.fn() };
    const rules = { onEvent: jest.fn(), onTagAdded: jest.fn() };
    const webhooks = {
        fromAutomationEvent: jest.fn(async () => {
            maxBusy = Math.max(maxBusy, ++busy);
            await new Promise((r) => setTimeout(r, 20));
            busy--;
        }),
    };
    const dispatcher = new AutomationDispatcher(prisma as never, jobs as never, rules as never, webhooks as never, fakeRedis() as never);
    return { dispatcher, prisma, jobs, rules, created, processed, maxBusy: () => maxBusy };
}

describe('AutomationDispatcher', () => {
    it('handles one person’s events one at a time, oldest first', async () => {
        const first = event({ id: 'e1', text: 'Hi', occurredAt: at(0), createdAt: at(1) });
        const second = event({ id: 'e2', text: 'price?', occurredAt: at(1), createdAt: at(2) });
        const h = harness({ events: [first, second], triggers: [trigger('welcome')] });

        await Promise.all([h.dispatcher.handle('e2'), h.dispatcher.handle('e1')]);

        expect(h.processed).toEqual(['e1', 'e2']);
        expect(h.maxBusy()).toBe(1);
        // The "once" welcome starts for the first message only.
        expect(h.created.map((r) => [r.eventId, r.status])).toEqual([['e1', 'PENDING'], ['e2', 'SKIPPED']]);
        expect(h.jobs.run).toHaveBeenCalledTimes(1);
    });

    it('reads "once" from the published version, not the draft', async () => {
        const draftSaysEveryTime = trigger('t', {}, 'ever');
        draftSaysEveryTime.automation.settings = { oncePerContact: 'never' };
        const h = harness({ events: [event()], triggers: [draftSaysEveryTime], ranBefore: ['a-t'] });
        await h.dispatcher.handle('e1');
        expect(h.created.map((r) => [r.status, r.skipReason])).toEqual([['SKIPPED', 'once_per_contact']]);

        const published = harness({ events: [event()], triggers: [trigger('t', {}, 'never')], ranBefore: ['a-t'] });
        await published.dispatcher.handle('e1');
        expect(published.created.map((r) => r.status)).toEqual(['PENDING']);
    });

    it('lets the next best automation answer when the best one already ran for this person', async () => {
        const keyword = trigger('kw', { keywords: ['hi'], config: { match: 'exact' } }, 'ever');
        const menu = trigger('menu', {}, 'never');
        const h = harness({ events: [event({ text: 'hi' })], triggers: [keyword, menu], ranBefore: ['a-kw'] });
        await h.dispatcher.handle('e1');
        expect(h.created.map((r) => [r.automationId, r.status])).toEqual([['a-menu', 'PENDING']]);
        expect(h.jobs.run).toHaveBeenCalledWith('run-1');

        // With nothing else to answer, the best one is recorded as skipped.
        const alone = harness({ events: [event({ text: 'hi' })], triggers: [keyword], ranBefore: ['a-kw'] });
        await alone.dispatcher.handle('e1');
        expect(alone.created.map((r) => [r.automationId, r.status])).toEqual([['a-kw', 'SKIPPED']]);
    });

    it('leaves a chat from an ad to the ad’s automation: no message automation, no welcome', async () => {
        const fromAd = event({ payload: { raw: { newConversation: true, referral: { source_type: 'ad', source_id: '120210000000001' } } } });
        const ad = trigger('ad', { triggerType: 'crm.ad.referral', channelId: null }, 'ever');
        const h = harness({ events: [fromAd], triggers: [trigger('menu', {}, 'never'), ad] });
        await h.dispatcher.handle('e1');
        expect(h.created).toEqual([]);
        expect(h.rules.onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), { automated: true });

        // The ad's automation already greeted this person: the message is answered as usual.
        const again = harness({ events: [{ ...fromAd, processedAt: null }], triggers: [trigger('menu', {}, 'never'), ad], ranBefore: ['a-ad'] });
        await again.dispatcher.handle('e1');
        expect(again.created.map((r) => r.automationId)).toEqual(['a-menu']);

        // Another ad than the one the automation names.
        const otherAd = harness({ events: [{ ...fromAd, processedAt: null }], triggers: [trigger('menu', {}, 'never'), { ...ad, keywords: ['999999999'] }] });
        await otherAd.dispatcher.handle('e1');
        expect(otherAd.created.map((r) => r.automationId)).toEqual(['a-menu']);
    });

    it('gives a reply to its waiting run even when the run’s version no longer parses', async () => {
        const waiting = { id: 'r1', context: { vars: {} }, currentStepKey: 'w', version: { definition: { steps: 'not a list' } } };
        const h = harness({ events: [event({ text: 'Confirm' })], triggers: [trigger('menu', {}, 'never')], waiting });
        await h.dispatcher.handle('e1');
        expect(h.jobs.resume).toHaveBeenCalledWith('r1', 'reply');
        expect(h.created).toEqual([]);
        expect(h.processed).toEqual(['e1']);
    });
});

describe('AutomationDispatcher — the recommended pack', () => {
    const tap = (raw: Row, text = 'Confirm order') => event({ text, payload: { raw } });
    const waitingRun = { id: 'r1', context: { vars: { last_reply_payload: 'stale' } }, currentStepKey: 'w', version: { definition: { steps: [{ id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'message' } }, { id: 'w', type: 'wait_for_reply', config: {} }] } } };
    const handedVars = (h: ReturnType<typeof harness>) => (h.prisma.automationRun.updateMany.mock.calls[0] as Row[])[0].data.context.vars;

    it('gives a waiting run the payload of the button tapped, as {{last_reply_payload}}', async () => {
        const template = harness({ events: [tap({ type: 'button', button: { text: 'Confirm order', payload: 'collabo_cod_confirm' } })], waiting: waitingRun });
        await template.dispatcher.handle('e1');
        expect(handedVars(template)).toMatchObject({ last_reply: 'Confirm order', last_reply_payload: 'collabo_cod_confirm' });

        const button = harness({ events: [tap({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'r1.s_0', title: 'Yes' } } }, 'Yes')], waiting: waitingRun });
        await button.dispatcher.handle('e1');
        expect(handedVars(button).last_reply_payload).toBe('r1.s_0');

        // A typed reply carries none: an earlier tap's payload must not linger.
        const typed = harness({ events: [tap({ type: 'text', text: { body: 'yes' } }, 'yes')], waiting: waitingRun });
        await typed.dispatcher.handle('e1');
        expect(handedVars(typed)).not.toHaveProperty('last_reply_payload');
    });

    const orderEvent = (eventType: string, occurredAt = at(0)) => event({ eventType, externalId: 'ord1:created', orderId: 'ord1', text: null, occurredAt, payload: { raw: { vars: {} } } });
    const storeTrigger = (id: string, eventType: string, config: Row) => trigger(id, { triggerType: eventType, channelId: null, config }, 'ever');

    it('starts no run for a sale at the till where the trigger leaves those out', async () => {
        const triggers = [storeTrigger('pack', 'crm.order.created', { match: 'contains', skipPos: true }), storeTrigger('mine', 'crm.order.created', { match: 'contains' })];
        for (const order of [{ posSale: true, sourceName: 'collabo-crm' }, { posSale: false, sourceName: 'pos' }]) {
            const h = harness({ events: [orderEvent('crm.order.created')], triggers, order: { ...order, externalCreatedAt: null, createdAt: at(0) } });
            await h.dispatcher.handle('e1');
            expect(h.created.map((r) => [r.automationId, r.status])).toEqual([['a-mine', 'PENDING']]);
        }
        const online = harness({ events: [orderEvent('crm.order.created')], triggers, order: { posSale: false, sourceName: 'web', externalCreatedAt: null, createdAt: at(0) } });
        await online.dispatcher.handle('e1');
        expect(online.created.map((r) => r.automationId)).toEqual(['a-pack', 'a-mine']);
    });

    it('starts no run for an invoice of an order older than the trigger looks at', async () => {
        const triggers = [storeTrigger('pack', 'crm.invoice.issued', { match: 'contains', orderWithinDays: 3 })];
        const placed = (daysAgo: number) => ({ posSale: false, sourceName: 'web', externalCreatedAt: new Date(at(0).getTime() - daysAgo * 24 * 3600_000), createdAt: at(0) });
        const recent = harness({ events: [orderEvent('crm.invoice.issued')], triggers, order: placed(2) });
        await recent.dispatcher.handle('e1');
        expect(recent.created).toHaveLength(1);
        const old = harness({ events: [orderEvent('crm.invoice.issued')], triggers, order: placed(40) });
        await old.dispatcher.handle('e1');
        expect(old.created).toHaveLength(0);
        expect(old.processed).toEqual(['e1']);
    });

    it('starts one cart sequence per shopper at a time where the trigger asks: a second checkout meanwhile is skipped, with why', async () => {
        const checkout = (id: string, s: number) => event({ id, eventType: 'crm.checkout.abandoned', externalId: `chk_${id}`, text: null, occurredAt: at(s), createdAt: at(s + 1), payload: { raw: { vars: {} } } });
        const pack = storeTrigger('pack', 'crm.checkout.abandoned', { match: 'contains', oneRunAtATime: true });
        const h = harness({ events: [checkout('e1', 0), checkout('e2', 2)], triggers: [pack] });
        await h.dispatcher.handle('e2');
        expect(h.created.map((r) => [r.eventId, r.status, r.skipReason])).toEqual([['e1', 'PENDING', null], ['e2', 'SKIPPED', 'already_running']]);
        // A merchant's own cart automation keeps one run per checkout.
        const mine = harness({ events: [checkout('e1', 0), checkout('e2', 2)], triggers: [storeTrigger('mine', 'crm.checkout.abandoned', { match: 'contains' })] });
        await mine.dispatcher.handle('e2');
        expect(mine.created.map((r) => r.status)).toEqual(['PENDING', 'PENDING']);
    });

    it('leaves to WhatsApp Pay an order update it already gave, where the trigger asks', async () => {
        const fulfilled = (raw: Row) => event({ eventType: 'crm.order.fulfilled', externalId: 'ord1:fulfilled', orderId: 'ord1', text: null, payload: { raw } });
        const triggers = [storeTrigger('pack', 'crm.order.fulfilled', { match: 'contains', skipWhatsAppPay: true }), storeTrigger('mine', 'crm.order.fulfilled', { match: 'contains' })];
        const h = harness({ events: [fulfilled({ vars: {}, whatsAppPayNotice: true })], triggers });
        await h.dispatcher.handle('e1');
        expect(h.created.map((r) => r.automationId)).toEqual(['a-mine']);
        const plain = harness({ events: [fulfilled({ vars: {} })], triggers });
        await plain.dispatcher.handle('e1');
        expect(plain.created.map((r) => r.automationId)).toEqual(['a-pack', 'a-mine']);
    });

    it('reads no order when no trigger asks', async () => {
        const h = harness({ events: [orderEvent('crm.order.created')], triggers: [storeTrigger('mine', 'crm.order.created', { match: 'contains' })] });
        await h.dispatcher.handle('e1');
        expect(h.prisma.order.findUnique).not.toHaveBeenCalled();
        expect(h.created).toHaveLength(1);
    });
});
