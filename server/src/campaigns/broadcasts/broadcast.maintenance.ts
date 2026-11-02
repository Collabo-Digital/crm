import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobType, Queue } from 'bullmq';
import { BroadcastRecipientStatus as R, BroadcastStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BROADCAST_QUEUE, BroadcastJobData, START_JOB_OPTS, startJobId } from './broadcast.queue';
import { BroadcastsService } from './broadcasts.service';

/// Queue states of a job that will still run.
const LIVE: JobType[] = ['active', 'waiting', 'delayed', 'prioritized', 'paused', 'waiting-children'];
/// A broadcast is left alone this long after it was due to start, or after it started sending.
const QUIET_MS = 5 * 60_000;
/// A scheduled broadcast whose start job was lost still goes out if it is at most this late.
const LATE_START_MS = 60 * 60_000;
/// People a broadcast left behind are still sent to within this long of it starting to send.
const RESUME_MS = 24 * 3600_000;
const BATCH = 100;

/**
 * Broadcast jobs live only in Redis, so a lost job (Redis restarted without
 * it, or a send batch that ran out of attempts) would leave a broadcast
 * Scheduled or Sending for good. This puts the database back in charge.
 */
@Injectable()
export class BroadcastMaintenance {
    private readonly logger = new Logger(BroadcastMaintenance.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly broadcasts: BroadcastsService,
        @InjectQueue(BROADCAST_QUEUE) private readonly queue: Queue<BroadcastJobData>,
    ) { }

    @Cron(CronExpression.EVERY_5_MINUTES)
    async sweep(now = new Date()) {
        await this.startOverdue(now);
        await this.settleSending(now);
    }

    /** Scheduled broadcasts past their time whose start job is gone: start them, or fail them if it is too late to send. */
    async startOverdue(now = new Date()) {
        const overdue = await this.prisma.broadcast.findMany({
            where: { status: BroadcastStatus.SCHEDULED, scheduledAt: { lt: new Date(now.getTime() - QUIET_MS) } },
            select: { id: true, scheduledAt: true },
            orderBy: { scheduledAt: 'asc' },
            take: BATCH,
        });
        for (const b of overdue) {
            await this.startOne(b.id, b.scheduledAt!, now).catch((err) => this.logger.error(`Broadcast ${b.id}: could not check its start: ${err}`));
        }
    }

    private async startOne(id: string, scheduledAt: Date, now: Date) {
        const job = await this.queue.getJob(startJobId(id));
        const state = job ? await job.getState() : null;
        if (state && (LIVE as string[]).includes(state)) return;
        if (job && state === 'failed') {
            await this.broadcasts.fail(id, `Sending could not start: ${job.failedReason}`);
        } else if (now.getTime() - scheduledAt.getTime() <= LATE_START_MS) {
            // A leftover job under the same id would make the add a no-op.
            await job?.remove();
            await this.queue.add('start', { kind: 'start', broadcastId: id }, { jobId: startJobId(id), ...START_JOB_OPTS });
            this.logger.warn(`Broadcast ${id}: its start job was lost; queued it again`);
        } else {
            await this.broadcasts.fail(id, 'Sending did not start at the scheduled time, so nothing was sent. Duplicate the broadcast to send it now.');
            this.logger.warn(`Broadcast ${id}: its start job was lost and it is too late to send`);
        }
    }

    /**
     * Sending broadcasts with no start or send job left: queue the people still
     * waiting again (the per-recipient idempotency key stops a second message
     * to anyone already sent to), or, once it is too late, mark them failed so
     * "Retry failed" can send them; then the broadcast completes.
     */
    async settleSending(now = new Date()) {
        const sending = await this.prisma.broadcast.findMany({
            where: { status: BroadcastStatus.SENDING, updatedAt: { lt: new Date(now.getTime() - QUIET_MS) } },
            select: { id: true, channelId: true, updatedAt: true },
            orderBy: { updatedAt: 'asc' },
            take: BATCH,
        });
        if (!sending.length) return;
        // Finish jobs only check for completion, which is done here too.
        const busy = new Set(
            (await this.queue.getJobs(LIVE)).filter((j) => j && j.data.kind !== 'finish').map((j) => j.data.broadcastId),
        );
        for (const b of sending) {
            if (busy.has(b.id)) continue;
            await this.settleOne(b, now).catch((err) => this.logger.error(`Broadcast ${b.id}: could not settle it: ${err}`));
        }
    }

    private async settleOne(b: { id: string; channelId: string; updatedAt: Date }, now: Date) {
        const left = await this.prisma.broadcastRecipient.findMany({
            where: { broadcastId: b.id, status: R.PENDING },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
        });
        if (left.length && now.getTime() - b.updatedAt.getTime() <= RESUME_MS) {
            await this.broadcasts.enqueueBatches(b, left.map((r) => r.id));
            this.logger.warn(`Broadcast ${b.id}: queued ${left.length} people again whose send jobs were lost or failed`);
            return;
        }
        if (left.length) {
            await this.prisma.broadcastRecipient.updateMany({
                where: { id: { in: left.map((r) => r.id) }, status: R.PENDING },
                data: { status: R.FAILED, failedAt: now, errorMessage: 'Not sent: sending stopped and did not resume within a day. Use “Retry failed” to send it now.' },
            });
        }
        await this.prisma.broadcast.updateMany({
            where: { id: b.id, status: BroadcastStatus.SENDING },
            data: { status: BroadcastStatus.COMPLETED, completedAt: now },
        });
    }
}
