import { AutomationRunner, DAILY_MESSAGE_CAP } from './automation-runner.service';

/**
 * Whether a person gets an automated message: not while paused after failed
 * sends, not a private reply to a comment Meta would refuse for age, and on
 * Instagram and Messenger not past the 24-hour cap. Public comment replies
 * are none of these.
 */

type Row = Record<string, any>;
const HOUR = 3600_000;

function harness(opts: { steps: Row[]; platform?: string; contact?: Row; sentToday?: number; commentAt?: string | null; eventType?: string }) {
    const platform = opts.platform ?? 'INSTAGRAM';
    const run: Row = {
        id: 'run1',
        organizationId: 'o',
        automationId: 'a1',
        automationVersionId: 'v1',
        eventId: 'evt1',
        contactId: 'c1',
        customerId: null,
        orderId: null,
        startedAt: null,
        createdAt: new Date(Date.now() - 60_000),
        currentStepKey: null,
        context: {
            vars: { trigger_text: 'price?' },
            trigger: { eventType: opts.eventType ?? 'instagram.comment', commentId: 'cm1', postId: 'p1', ...(opts.commentAt !== null ? { commentAt: opts.commentAt ?? new Date(Date.now() - HOUR).toISOString() } : {}) },
            depth: 0,
        },
        version: { definition: { steps: opts.steps } },
        automation: { id: 'a1', status: 'ACTIVE', ownerUserId: null, packKey: null },
    };
    const steps: Row[] = [];
    const prisma = {
        automationRun: {
            updateMany: jest.fn(async () => ({ count: 1 })),
            findUniqueOrThrow: jest.fn(async () => run),
            update: jest.fn(async ({ data }: Row) => Object.assign(run, data)),
        },
        automationRunStep: {
            upsert: jest.fn(async ({ where, create, update }: Row) => {
                const at = steps.findIndex((s) => s.stepKey === where.runId_stepKey_attempt.stepKey);
                if (at >= 0) Object.assign(steps[at], update);
                else steps.push({ ...create });
            }),
            updateMany: jest.fn(async () => ({ count: 1 })),
        },
        automation: { update: jest.fn(async () => ({})) },
        organization: { findUnique: jest.fn(async () => ({ name: 'Acme', timezone: 'Asia/Kolkata', settings: null })) },
        channelContact: {
            findUnique: jest.fn(async () => ({
                id: 'c1',
                channelId: 'ch1',
                platform,
                name: null,
                displayName: null,
                addressBookName: null,
                username: 'riya.k',
                phone: null,
                tags: [],
                attributes: {},
                optInAt: null,
                optedOutAt: null,
                mutedUntil: null,
                customerId: null,
                customer: null,
                ...opts.contact,
            })),
        },
        conversation: { findUnique: jest.fn(async () => ({ id: 'conv1', assignedUserId: null, platform, lastInboundAt: new Date() })) },
        message: { count: jest.fn(async () => opts.sentToday ?? 0) },
        note: { create: jest.fn(async () => ({})) },
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
    const none = {} as never;
    const runner = new AutomationRunner(prisma as never, sender as never, { resume: jest.fn(), event: jest.fn() } as never, none, { publish: jest.fn() } as never, none, none, none, none, none, none, none, { get: () => undefined } as never);
    jest.spyOn((runner as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    return { runner, run, prisma, sent, steps };
}

const trigger = { id: 't', type: 'trigger', config: { channel: 'instagram', event: 'comment', keyword: 'price' } };
const privateReply = { id: 'r', type: 'reply_comment', config: { mode: 'private', message: 'Here is the link' } };
const publicReply = { id: 'p', type: 'reply_comment', config: { mode: 'public', message: 'Sent you a DM!' } };
const dm = { id: 'm', type: 'send_message', config: { message: 'Anything else?' } };
const skippedAs = (steps: Row[], key: string) => steps.find((s) => s.stepKey === key)?.output?.skipped;

describe('AutomationRunner — who gets an automated message', () => {
    it('sends a private reply and a message when nothing stands in the way', async () => {
        const h = harness({ steps: [trigger, privateReply, dm] });
        await h.runner.run('run1');
        expect(h.sent.map((s) => s.payload.type)).toEqual(['private_reply', 'text']);
        expect(h.run.status).toBe('COMPLETED');
    });

    it('skips every message while the person is paused, and carries on with the run', async () => {
        const until = new Date(Date.now() + 5 * HOUR);
        const h = harness({ steps: [trigger, privateReply, dm], contact: { mutedUntil: until } });
        await h.runner.run('run1');
        expect(h.sent).toHaveLength(0);
        expect(skippedAs(h.steps, 'r')).toBe('paused_after_failures');
        expect(h.steps.find((s) => s.stepKey === 'r')).toMatchObject({ status: 'SKIPPED', output: { until: until.toISOString() } });
        expect(skippedAs(h.steps, 'm')).toBe('paused_after_failures');
        expect(h.run.status).toBe('COMPLETED');
    });

    it('sends again once the pause has ended', async () => {
        const h = harness({ steps: [trigger, dm], contact: { mutedUntil: new Date(Date.now() - 1000) } });
        await h.runner.run('run1');
        expect(h.sent).toHaveLength(1);
    });

    it('still answers a comment publicly while the person is paused or capped: it is under the post, not in their messages', async () => {
        const h = harness({ steps: [trigger, publicReply], contact: { mutedUntil: new Date(Date.now() + HOUR) }, sentToday: DAILY_MESSAGE_CAP });
        await h.runner.run('run1');
        expect(h.sent.map((s) => s.payload.type)).toEqual(['comment_reply']);
        expect(h.prisma.message.count).not.toHaveBeenCalled();
    });

    it('skips a private reply to a comment more than 7 days old, and sends the message after it', async () => {
        const h = harness({ steps: [trigger, privateReply, dm], commentAt: new Date(Date.now() - 8 * 24 * HOUR).toISOString() });
        await h.runner.run('run1');
        expect(skippedAs(h.steps, 'r')).toBe('comment_too_old');
        expect(h.sent.map((s) => s.payload.type)).toEqual(['text']);
    });

    it('sends a private reply for a run that started before the comment time was kept', async () => {
        const h = harness({ steps: [trigger, privateReply], commentAt: null });
        await h.runner.run('run1');
        expect(h.sent.map((s) => s.payload.type)).toEqual(['private_reply']);
    });

    it(`stops at ${DAILY_MESSAGE_CAP} automated messages to one person in 24 hours on Instagram`, async () => {
        const under = harness({ steps: [trigger, dm], sentToday: DAILY_MESSAGE_CAP - 1 });
        await under.runner.run('run1');
        expect(under.sent).toHaveLength(1);
        const where = (under.prisma.message.count.mock.calls[0] as unknown as [Row])[0].where;
        expect(where).toMatchObject({ contactId: 'c1', direction: 'OUTBOUND', source: 'AUTOMATION', kind: { not: 'COMMENT' }, status: { not: 'FAILED' } });
        expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(24 * HOUR - 5_000);

        const at = harness({ steps: [trigger, dm], sentToday: DAILY_MESSAGE_CAP });
        await at.runner.run('run1');
        expect(at.sent).toHaveLength(0);
        expect(at.steps.find((s) => s.stepKey === 'm')).toMatchObject({ status: 'SKIPPED', output: { skipped: 'daily_cap', cap: DAILY_MESSAGE_CAP } });
    });

    it('puts no daily cap on WhatsApp, where order updates must arrive, but keeps the pause', async () => {
        const waTrigger = { id: 't', type: 'trigger', config: { channel: 'whatsapp', event: 'message', keyword: 'hi' } };
        const capped = harness({ steps: [waTrigger, dm], platform: 'WHATSAPP', eventType: 'whatsapp.message', sentToday: 50 });
        await capped.runner.run('run1');
        expect(capped.sent).toHaveLength(1);
        expect(capped.prisma.message.count).not.toHaveBeenCalled();

        const paused = harness({ steps: [waTrigger, dm], platform: 'WHATSAPP', eventType: 'whatsapp.message', contact: { mutedUntil: new Date(Date.now() + HOUR) } });
        await paused.runner.run('run1');
        expect(paused.sent).toHaveLength(0);
        expect(skippedAs(paused.steps, 'm')).toBe('paused_after_failures');
    });
});
