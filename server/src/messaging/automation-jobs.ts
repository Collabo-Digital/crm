import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const AUTOMATION_QUEUE = 'automation';

export type AutomationJobData =
    /** An event was stored: match it against inbox rules and triggers. */
    | { kind: 'event'; eventId: string }
    /** Execute a run from its current step. */
    | { kind: 'run'; runId: string }
    /** Wake a waiting run: its timer ran out, or the reply it waited for came. */
    | { kind: 'resume'; runId: string; reason: 'timer' | 'reply' };

/**
 * Bring an organization's recommended-pack automations up to date with its
 * pack templates: create them, put them live once their templates are
 * approved. Queued by the template pack (jobId `managed-sync-<orgId>`) after
 * it runs and when a pack template's status or category changes; routed by
 * job name, not `kind`.
 */
export const MANAGED_SYNC_JOB = 'managed-sync';
export interface ManagedSyncJobData {
    organizationId: string;
}

const OPTS = { attempts: 5, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 1000, removeOnFail: { count: 1000 } };

/**
 * The one way work reaches the automation engine. Lives with messaging so the
 * writers of events (ingest, contact edits, webhooks) can queue without
 * depending on the engine; a sweeper catches anything a failed enqueue lost.
 */
@Injectable()
export class AutomationJobs {
    private readonly logger = new Logger(AutomationJobs.name);

    constructor(@InjectQueue(AUTOMATION_QUEUE) private readonly queue: Queue<AutomationJobData>) { }

    async event(eventId: string): Promise<void> {
        await this.add({ kind: 'event', eventId }, `event-${eventId}`);
    }

    async run(runId: string, delayMs = 0): Promise<void> {
        await this.add({ kind: 'run', runId }, `run-${runId}-${Date.now()}`, delayMs);
    }

    /** Timer wake-ups are keyed by run and time, so a re-armed wait never fires twice. */
    async resume(runId: string, reason: 'timer' | 'reply', at?: Date): Promise<void> {
        const delay = at ? Math.max(0, at.getTime() - Date.now()) : 0;
        await this.add({ kind: 'resume', runId, reason }, `resume-${runId}-${reason}-${at?.getTime() ?? Date.now()}`, delay);
    }

    private async add(data: AutomationJobData, jobId: string, delay = 0) {
        await this.queue.add(data.kind, data, { ...OPTS, jobId, delay }).catch((err) => {
            // The sweeper picks up unprocessed events and overdue runs.
            this.logger.warn(`Automation job ${jobId} not queued: ${err instanceof Error ? err.message : err}`);
        });
    }
}
