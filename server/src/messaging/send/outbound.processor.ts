import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { isRateLimitedError } from '../../rate-limit/rate-limit.types';
import { parkIfRateLimited } from '../../rate-limit/bullmq-park.util';
import { MESSAGING_OUTBOUND_QUEUE, OutboundJobData, maxSendWaitMs } from './outbound.queue';
import { PlatformSenderService, describeSendFailure } from './platform-sender.service';

/// Concurrent sends across all tenants. Per-number pacing is the rate
/// limiter's job; this only bounds database and connection use.
const OUTBOUND_CONCURRENCY = Number.parseInt(process.env.MESSAGING_OUTBOUND_CONCURRENCY ?? '5', 10) || 5;

@Processor(MESSAGING_OUTBOUND_QUEUE, { concurrency: OUTBOUND_CONCURRENCY })
export class OutboundProcessor extends WorkerHost {
    private readonly logger = new Logger(OutboundProcessor.name);

    constructor(private readonly sender: PlatformSenderService) {
        super();
    }

    async process(job: Job<OutboundJobData>, token?: string): Promise<void> {
        try {
            if (job.data.kind === 'deliver') {
                await this.sender.deliver(job.data.messageId, job.data.humanAgentTag);
            } else {
                await this.sender.markRead(job.data.channelId, job.data.contactExternalId, job.data.messageExternalId);
            }
        } catch (err) {
            if (job.data.kind === 'deliver' && isRateLimitedError(err) && Date.now() - job.timestamp > maxSendWaitMs(job.opts.priority)) {
                // Parking never counts as an attempt, so without this a limited number would hold the message for ever.
                await this.sender.giveUp(
                    job.data.messageId,
                    describeSendFailure(err.metaCode, 'WhatsApp kept limiting how fast this number can send, so this message was not sent. Send it again.'),
                    err.metaCode,
                );
                return;
            }
            if (isRateLimitedError(err) && err.scope.kind === 'app') {
                // The app-wide wallet is shared by every tenant: pause the worker,
                // not just this job.
                await this.worker.rateLimit(Math.max(1_000, err.retryAtMs - Date.now()));
                throw Worker.RateLimitError();
            }
            if (!isRateLimitedError(err) && job.data.kind === 'deliver' && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
                await this.sender.giveUp(job.data.messageId, 'Meta could not be reached. Try sending again.');
            }
            await parkIfRateLimited(err, job, token, this.logger);
        }
    }
}
