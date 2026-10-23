import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CoexistenceSyncJobData, WHATSAPP_ONBOARDING_QUEUE } from './whatsapp-onboarding.queue';
import { WhatsAppAccountService } from './whatsapp-account.service';

@Processor(WHATSAPP_ONBOARDING_QUEUE)
export class WhatsAppOnboardingProcessor extends WorkerHost {
    private readonly logger = new Logger(WhatsAppOnboardingProcessor.name);

    constructor(private readonly account: WhatsAppAccountService) {
        super();
    }

    async process(job: Job<CoexistenceSyncJobData>): Promise<void> {
        try {
            const outcome = await this.account.runCoexistenceSync(job.data.channelId);
            this.logger.log(`Coexistence sync for channel ${job.data.channelId}: ${outcome}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
            this.logger.warn(
                `Coexistence sync for channel ${job.data.channelId} failed (attempt ${job.attemptsMade + 1}): ${message}`,
            );
            if (last) await this.account.markSyncFailed(job.data.channelId, message);
            throw err;
        }
    }
}
