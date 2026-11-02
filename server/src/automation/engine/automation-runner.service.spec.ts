import { AutomationRunner } from './automation-runner.service';

describe('AutomationRunner', () => {
    function runner(run: Record<string, unknown>, readOnly = false) {
        const prisma = {
            automationRun: {
                updateMany: jest.fn(async () => ({ count: 1 })),
                findUniqueOrThrow: jest.fn(async () => run),
                update: jest.fn(async () => ({})),
            },
            automation: { update: jest.fn(async () => ({})) },
            automationRunStep: { updateMany: jest.fn() },
            $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
        };
        const none = {} as never;
        const billingAccess = { isReadOnly: jest.fn(() => Promise.resolve(readOnly)) };
        const r = new AutomationRunner(prisma as never, none, none, none, none, none, none, none, none, none, none, none, { get: () => undefined } as never, billingAccess as never);
        return { r, prisma };
    }
    const broken = {
        id: 'run1',
        automationId: 'a1',
        automationVersionId: 'v1',
        startedAt: new Date(),
        currentStepKey: 'w',
        context: {},
        version: { definition: { steps: [{ id: 'w', type: 'no_such_block', config: {} }] } },
        automation: { id: 'a1', status: 'ACTIVE', ownerUserId: null },
    };

    it.each(['run', 'resume'] as const)('fails a run whose stored version no longer parses (%s)', async (how) => {
        const { r, prisma } = runner(broken);
        if (how === 'run') await r.run('run1');
        else await r.resume('run1', 'reply');
        expect(prisma.automationRun.update).toHaveBeenCalledWith({
            where: { id: 'run1' },
            data: expect.objectContaining({ status: 'FAILED', waitingForReply: false, resumeAt: null, error: expect.stringContaining('publish it again') }),
        });
        expect(prisma.automation.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: expect.objectContaining({ lastError: expect.stringContaining('can no longer run') }) });
        expect(prisma.automationRunStep.updateMany).not.toHaveBeenCalled();
    });

    it.each(['run', 'resume'] as const)('skips every run of a read-only workspace before any step (%s)', async (how) => {
        const { r, prisma } = runner({ ...broken, organizationId: 'org1' }, true);
        if (how === 'run') await r.run('run1');
        else await r.resume('run1', 'timer');
        const [skipped] = prisma.automationRun.update.mock.calls.at(-1) as unknown as [{ where: unknown; data: { completedAt: unknown } }];
        expect(skipped.where).toEqual({ id: 'run1' });
        expect(skipped.data).toMatchObject({ status: 'SKIPPED', skipReason: 'read_only', waitingForReply: false });
        expect(skipped.data.completedAt).toBeInstanceOf(Date);
        // The stored version is never read, so nothing about the flow ran.
        expect(prisma.automation.update).not.toHaveBeenCalled();
        expect(prisma.automationRunStep.updateMany).not.toHaveBeenCalled();
    });
});
