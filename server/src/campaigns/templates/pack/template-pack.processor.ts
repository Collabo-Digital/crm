import { Processor, WorkerHost } from '@nestjs/bullmq';
import { BadRequestException, Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { LockTimeoutError } from '../../../automation/engine/redis-lock';
import { parkIfRateLimited } from '../../../rate-limit/bullmq-park.util';
import { isRateLimitedError } from '../../../rate-limit/rate-limit.types';
import { TemplatesService } from '../templates.service';
import { TemplatePackService } from './template-pack.service';
import { PackEnsureJob, PackReconcileJob, TEMPLATE_PACK_QUEUE, TemplatePackJobData, TemplateSyncJob } from './template-pack.queue';

/** An account whose templates are being worked on by another job: try again this much later, without using an attempt. */
const LOCKED_RETRY_MS = 60_000;

/**
 * The template-pack queue's one processor. Two accounts at a time; on one
 * account the pack's creates, reconciles and syncs take turns through the
 * account's template lock.
 */
@Processor(TEMPLATE_PACK_QUEUE, { concurrency: 2 })
export class TemplatePackProcessor extends WorkerHost {
    private readonly logger = new Logger(TemplatePackProcessor.name);

    constructor(
        private readonly pack: TemplatePackService,
        private readonly templates: TemplatesService,
    ) {
        super();
    }

    async process(job: Job<TemplatePackJobData>, token?: string): Promise<void> {
        try {
            switch (job.name) {
                case 'ensure': {
                    const { organizationId, wabaId, reason } = job.data as PackEnsureJob;
                    return await this.pack.ensure(organizationId, wabaId, reason);
                }
                case 'reconcile': {
                    const { organizationId, wabaId } = job.data as PackReconcileJob;
                    return await this.pack.reconcile(organizationId, wabaId);
                }
                case 'sync': {
                    await this.templates.sync((job.data as TemplateSyncJob).organizationId, { waitMs: 5_000 }).catch((err) => {
                        // No WhatsApp number any more: nothing to sync.
                        if (!(err instanceof BadRequestException)) throw err;
                    });
                    return;
                }
                default:
                    this.logger.warn(`Unknown template-pack job ${job.name}`);
            }
        } catch (err) {
            if (err instanceof LockTimeoutError && token) {
                await job.moveToDelayed(Date.now() + LOCKED_RETRY_MS, token);
                throw new DelayedError();
            }
            if (!isRateLimitedError(err)) this.logger.warn(`Template pack job ${job.name} ${job.id} failed: ${err instanceof Error ? err.message : err}`);
            await parkIfRateLimited(err, job, token, this.logger);
        }
    }
}
