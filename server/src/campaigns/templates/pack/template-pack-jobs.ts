import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AUTOMATION_QUEUE } from '../../../messaging/automation-jobs';
import { Priority } from '../../../rate-limit/rate-limit.types';
import {
    PACK_JOB_OPTS,
    PackEnsureReason,
    TEMPLATE_PACK_QUEUE,
    TemplatePackJobData,
    addReplacingFinished,
    addWithFollowUp,
    packJobId,
    queuePackEnsure,
} from './template-pack.queue';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** While a pack template is in review: re-read it this long after an ensure, in case Meta's webhook never comes. */
const RECONCILE_AFTER: Array<[label: string, delayMs: number]> = [
    ['10m', 10 * MINUTE],
    ['1h', HOUR],
    ['6h', 6 * HOUR],
    ['24h', 24 * HOUR],
];

/** As the automation queue's own jobs (AutomationJobs). */
const MANAGED_SYNC_OPTS = { attempts: 5, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 1000, removeOnFail: { count: 1000 } };

/**
 * Queues the pack's work, and the automation engine's `managed-sync` (which
 * creates the pack's automations and switches on the ones whose templates
 * are approved). Never throws: a lost job is caught up by the next ensure,
 * the delayed reconciles or the six-hourly sync.
 */
@Injectable()
export class TemplatePackJobs {
    private readonly logger = new Logger(TemplatePackJobs.name);

    constructor(
        @InjectQueue(TEMPLATE_PACK_QUEUE) private readonly queue: Queue<TemplatePackJobData>,
        @InjectQueue(AUTOMATION_QUEUE) private readonly automation: Queue,
    ) { }

    ensure(organizationId: string, wabaId: string, reason: PackEnsureReason, delayMs = 0): Promise<void> {
        return this.quietly(`pack-ensure-${organizationId}`, () => queuePackEnsure(this.queue, { organizationId, wabaId, reason }, { delayMs }));
    }

    reconcile(organizationId: string, wabaId: string): Promise<void> {
        return this.quietly(`pack-reconcile-${organizationId}`, () =>
            addWithFollowUp(this.queue, 'reconcile', { organizationId, wabaId }, { ...PACK_JOB_OPTS, jobId: packJobId.reconcile(organizationId), priority: Priority.NORMAL }));
    }

    /** One reconcile, later; e.g. after Meta's template-creation limit. */
    reconcileIn(organizationId: string, wabaId: string, delayMs: number, label: string): Promise<void> {
        return this.quietly(`pack-reconcile-${organizationId}-${label}`, () =>
            addReplacingFinished(this.queue, 'reconcile', { organizationId, wabaId }, {
                ...PACK_JOB_OPTS,
                jobId: `${packJobId.reconcile(organizationId)}-${label}`,
                priority: Priority.NORMAL,
                delay: delayMs,
            }));
    }

    /** The follow-up reconciles while anything is in review. */
    async reconcileLater(organizationId: string, wabaId: string): Promise<void> {
        for (const [label, delayMs] of RECONCILE_AFTER) await this.reconcileIn(organizationId, wabaId, delayMs, label);
    }

    /** A full sync for the account, one at a time per organization. */
    sync(organizationId: string): Promise<void> {
        return this.quietly(`template-sync-${organizationId}`, () =>
            addWithFollowUp(this.queue, 'sync', { organizationId }, { ...PACK_JOB_OPTS, attempts: 3, jobId: packJobId.sync(organizationId), priority: Priority.NORMAL }));
    }

    managedSync(organizationId: string): Promise<void> {
        return this.quietly(`managed-sync-${organizationId}`, () =>
            addWithFollowUp(this.automation, 'managed-sync', { organizationId }, { ...MANAGED_SYNC_OPTS, jobId: `managed-sync-${organizationId}` }));
    }

    private async quietly(jobId: string, add: () => Promise<unknown>): Promise<void> {
        await add().catch((err) => this.logger.warn(`Job ${jobId} not queued: ${err instanceof Error ? err.message : err}`));
    }
}
