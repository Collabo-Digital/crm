import { AutomationSweeper } from './automation.processor';

describe('AutomationSweeper', () => {
    it('resumes runs that were given their reply but never resumed', async () => {
        const findMany = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
            where.status === 'WAITING' && where.resumeAt === null && where.waitingForReply === false ? [{ id: 'answered' }] : [],
        );
        const prisma = { automationEvent: { findMany: jest.fn(async () => []) }, automationRun: { findMany } };
        const jobs = { event: jest.fn(), resume: jest.fn(), run: jest.fn() };
        const now = new Date('2026-10-25T10:00:00Z');

        await expect(new AutomationSweeper(prisma as never, jobs as never).sweep(now)).resolves.toBe(1);

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'WAITING', resumeAt: null, waitingForReply: false, updatedAt: { lt: new Date('2026-10-25T09:59:00Z') } } }));
        expect(jobs.resume).toHaveBeenCalledWith('answered', 'reply');
        expect(jobs.run).not.toHaveBeenCalled();
    });
});
