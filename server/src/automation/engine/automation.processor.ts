import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Job } from 'bullmq';
import { AutomationRunStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AUTOMATION_QUEUE, AutomationJobData, AutomationJobs, MANAGED_SYNC_JOB, ManagedSyncJobData } from '../../messaging/automation-jobs';
import { ManagedAutomationsService } from '../pack/managed-automations.service';
import { AutomationDispatcher } from './automation-dispatcher.service';
import { AutomationRunner, STALE_RUN_MS } from './automation-runner.service';

@Processor(AUTOMATION_QUEUE, { concurrency: 5 })
export class AutomationProcessor extends WorkerHost {
    private readonly logger = new Logger(AutomationProcessor.name);

    constructor(
        private readonly dispatcher: AutomationDispatcher,
        private readonly runner: AutomationRunner,
        private readonly managed: ManagedAutomationsService,
    ) {
        super();
    }

    async process(job: Job<AutomationJobData | ManagedSyncJobData>): Promise<void> {
        if (job.name === MANAGED_SYNC_JOB) {
            const { organizationId } = job.data as ManagedSyncJobData;
            try {
                return await this.managed.sync(organizationId);
            } catch (err) {
                this.logger.warn(`Managed automations of ${organizationId} not synced: ${err instanceof Error ? err.message : err}`);
                throw err;
            }
        }
        const data = job.data as AutomationJobData;
        try {
            switch (data.kind) {
                case 'event':
                    return await this.dispatcher.handle(data.eventId);
                case 'run':
                    return await this.runner.run(data.runId);
                case 'resume':
                    return await this.runner.resume(data.runId, data.reason);
            }
        } catch (err) {
            this.logger.warn(`Automation job ${data.kind} failed: ${err instanceof Error ? err.message : err}`);
            throw err;
        }
    }
}

/**
 * The backstop for lost jobs: events nobody processed, waits whose wake-up
 * never fired, replies whose resume was never queued, runs that never
 * started or whose worker died.
 */
@Injectable()
export class AutomationSweeper {
    private readonly logger = new Logger(AutomationSweeper.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly jobs: AutomationJobs,
    ) { }

    @Cron(CronExpression.EVERY_MINUTE)
    async sweep(now = new Date()) {
        const minuteAgo = new Date(now.getTime() - 60_000);
        const [events, overdue, answered, pending, stale] = await Promise.all([
            this.prisma.automationEvent.findMany({
                where: { processedAt: null, error: null, createdAt: { lt: minuteAgo, gt: new Date(now.getTime() - 24 * 3600_000) } },
                select: { id: true },
                take: 200,
            }),
            this.prisma.automationRun.findMany({
                where: { status: AutomationRunStatus.WAITING, resumeAt: { lt: minuteAgo } },
                select: { id: true },
                take: 200,
            }),
            // The dispatcher gave these their reply (no timer, not waiting) but their resume never ran.
            this.prisma.automationRun.findMany({
                where: { status: AutomationRunStatus.WAITING, resumeAt: null, waitingForReply: false, updatedAt: { lt: minuteAgo } },
                select: { id: true },
                take: 200,
            }),
            this.prisma.automationRun.findMany({
                where: { status: AutomationRunStatus.PENDING, createdAt: { lt: minuteAgo } },
                select: { id: true },
                take: 200,
            }),
            this.prisma.automationRun.findMany({
                where: { status: AutomationRunStatus.RUNNING, updatedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } },
                select: { id: true },
                take: 200,
            }),
        ]);
        for (const e of events) await this.jobs.event(e.id);
        for (const r of overdue) await this.jobs.resume(r.id, 'timer');
        for (const r of answered) await this.jobs.resume(r.id, 'reply');
        for (const r of [...pending, ...stale]) await this.jobs.run(r.id);
        const total = events.length + overdue.length + answered.length + pending.length + stale.length;
        if (total) this.logger.log(`Swept ${events.length} events, ${overdue.length} waits, ${answered.length} replies, ${pending.length + stale.length} runs`);
        return total;
    }
}
