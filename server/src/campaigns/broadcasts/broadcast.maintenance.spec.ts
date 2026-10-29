import { BroadcastRecipientStatus as R, BroadcastStatus } from '@prisma/client';
import { BroadcastMaintenance } from './broadcast.maintenance';
import { startJobId } from './broadcast.queue';
import { BroadcastsService } from './broadcasts.service';

const NOW = new Date('2026-10-25T10:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function build(opts: { scheduled?: { id: string; scheduledAt: Date }[]; sending?: { id: string; channelId: string; updatedAt: Date }[]; pending?: string[]; job?: { state: string; failedReason?: string } | null; liveJobs?: { kind: string; broadcastId: string }[] }) {
    const job = opts.job ? { getState: jest.fn().mockResolvedValue(opts.job.state), failedReason: opts.job.failedReason, remove: jest.fn() } : null;
    const prisma = {
        broadcast: {
            findMany: jest.fn(async ({ where }: any) => (where.status === BroadcastStatus.SCHEDULED ? opts.scheduled ?? [] : opts.sending ?? [])),
            updateMany: jest.fn(),
        },
        broadcastRecipient: {
            findMany: jest.fn(async () => (opts.pending ?? []).map((id) => ({ id }))),
            updateMany: jest.fn(),
        },
    };
    const queue = {
        getJob: jest.fn().mockResolvedValue(job),
        getJobs: jest.fn().mockResolvedValue((opts.liveJobs ?? []).map((data) => ({ data }))),
        add: jest.fn(),
    };
    const broadcasts = { fail: jest.fn(), enqueueBatches: jest.fn() };
    return { prisma, queue, broadcasts, job, sweeper: new BroadcastMaintenance(prisma as any, broadcasts as any, queue as any) };
}

describe('BroadcastMaintenance: scheduled broadcasts', () => {
    it('queues the start again when its job is gone and the broadcast is a little late', async () => {
        const t = build({ scheduled: [{ id: 'b1', scheduledAt: minutesAgo(10) }], job: null });
        await t.sweeper.startOverdue(NOW);
        expect(t.queue.add).toHaveBeenCalledWith('start', { kind: 'start', broadcastId: 'b1' }, expect.objectContaining({ jobId: startJobId('b1') }));
        expect(t.broadcasts.fail).not.toHaveBeenCalled();
    });

    it('fails, without sending, a broadcast whose start job is gone and that is over an hour late', async () => {
        const t = build({ scheduled: [{ id: 'b1', scheduledAt: minutesAgo(90) }], job: null });
        await t.sweeper.startOverdue(NOW);
        expect(t.queue.add).not.toHaveBeenCalled();
        expect(t.broadcasts.fail).toHaveBeenCalledWith('b1', expect.stringContaining('nothing was sent'));
    });

    it('leaves a start job that is still waiting its turn', async () => {
        const t = build({ scheduled: [{ id: 'b1', scheduledAt: minutesAgo(90) }], job: { state: 'waiting' } });
        await t.sweeper.startOverdue(NOW);
        expect(t.queue.add).not.toHaveBeenCalled();
        expect(t.broadcasts.fail).not.toHaveBeenCalled();
    });

    it('fails the broadcast with the reason when its start job failed', async () => {
        const t = build({ scheduled: [{ id: 'b1', scheduledAt: minutesAgo(10) }], job: { state: 'failed', failedReason: 'header upload refused' } });
        await t.sweeper.startOverdue(NOW);
        expect(t.broadcasts.fail).toHaveBeenCalledWith('b1', 'Sending could not start: header upload refused');
        expect(t.queue.add).not.toHaveBeenCalled();
    });

    it('carries on with the next broadcast when one cannot be checked', async () => {
        const t = build({ scheduled: [{ id: 'b1', scheduledAt: minutesAgo(10) }, { id: 'b2', scheduledAt: minutesAgo(10) }], job: null });
        t.queue.getJob.mockRejectedValueOnce(new Error('Connection is closed.'));
        await t.sweeper.startOverdue(NOW);
        expect(t.queue.add).toHaveBeenCalledTimes(1);
        expect(t.queue.add).toHaveBeenCalledWith('start', { kind: 'start', broadcastId: 'b2' }, expect.anything());
    });

    it('removes a leftover job under the same id before queuing the start again', async () => {
        const t = build({ scheduled: [{ id: 'b1', scheduledAt: minutesAgo(10) }], job: { state: 'unknown' } });
        await t.sweeper.startOverdue(NOW);
        expect(t.job!.remove).toHaveBeenCalled();
        expect(t.queue.add).toHaveBeenCalled();
    });
});

describe('BroadcastMaintenance: sending broadcasts', () => {
    const sending = (startedMinutesAgo: number) => [{ id: 'b1', channelId: 'ch1', updatedAt: minutesAgo(startedMinutesAgo) }];

    it('queues again the people whose send jobs were lost', async () => {
        const t = build({ sending: sending(30), pending: ['r1', 'r2'] });
        await t.sweeper.settleSending(NOW);
        expect(t.broadcasts.enqueueBatches).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1', channelId: 'ch1' }), ['r1', 'r2']);
        expect(t.prisma.broadcast.updateMany).not.toHaveBeenCalled();
    });

    it('leaves a broadcast whose send jobs are still queued', async () => {
        const t = build({ sending: sending(30), pending: ['r1'], liveJobs: [{ kind: 'send', broadcastId: 'b1' }] });
        await t.sweeper.settleSending(NOW);
        expect(t.broadcasts.enqueueBatches).not.toHaveBeenCalled();
        expect(t.prisma.broadcast.updateMany).not.toHaveBeenCalled();
    });

    it('completes a broadcast with nobody left to send to, though its finish checks have stopped', async () => {
        const t = build({ sending: sending(120), pending: [], liveJobs: [{ kind: 'finish', broadcastId: 'b1' }] });
        await t.sweeper.settleSending(NOW);
        expect(t.prisma.broadcast.updateMany).toHaveBeenCalledWith({
            where: { id: 'b1', status: BroadcastStatus.SENDING },
            data: { status: BroadcastStatus.COMPLETED, completedAt: NOW },
        });
    });

    it('marks people left behind over a day ago failed, so they can be retried, instead of sending now', async () => {
        const t = build({ sending: sending(25 * 60), pending: ['r1'] });
        await t.sweeper.settleSending(NOW);
        expect(t.broadcasts.enqueueBatches).not.toHaveBeenCalled();
        expect(t.prisma.broadcastRecipient.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: { in: ['r1'] }, status: R.PENDING }, data: expect.objectContaining({ status: R.FAILED }) }),
        );
        expect(t.prisma.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: BroadcastStatus.COMPLETED, completedAt: NOW } }));
    });
});

describe('Scheduling a broadcast when the queue cannot take it', () => {
    it('keeps it a draft and says so, instead of leaving it Scheduled with nothing to start it', async () => {
        const prisma = {
            broadcast: {
                findFirst: jest.fn().mockResolvedValue({ id: 'b1', organizationId: 'org1', status: BroadcastStatus.DRAFT }),
                update: jest.fn(),
            },
        };
        const queue = { add: jest.fn().mockRejectedValue(new Error('Connection is closed.')) };
        const service = new BroadcastsService(prisma as any, {} as any, {} as any, {} as any, {} as any, queue as any);
        jest.spyOn(service, 'preview').mockResolvedValue({ ready: true, blockers: [] } as any);
        await expect(service.schedule('org1', 'b1', null)).rejects.toThrow('The broadcast was not scheduled and is still a draft. Try again in a minute.');
        expect(prisma.broadcast.update).toHaveBeenLastCalledWith({ where: { id: 'b1' }, data: { status: BroadcastStatus.DRAFT, scheduledAt: null } });
    });
});
