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

function harness(opts: { events: Row[]; triggers?: Row[]; ranBefore?: string[]; waiting?: Row | null }) {
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
