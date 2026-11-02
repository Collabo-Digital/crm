import { AutomationRunner } from './automation-runner.service';

describe('AutomationRunner', () => {
    function runner(run: Record<string, unknown>) {
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
        const r = new AutomationRunner(prisma as never, none, none, none, none, none, none, none, none, none, none, none, { get: () => undefined } as never);
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
});
