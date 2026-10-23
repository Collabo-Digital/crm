import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { MessageStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isRateLimitedError } from '../../rate-limit/rate-limit.types';
import { parkIfRateLimited } from '../../rate-limit/bullmq-park.util';
import { MESSAGING_OUTBOUND_QUEUE, OutboundJobData } from './outbound.queue';
import { PlatformSenderService } from './platform-sender.service';

/// Concurrent sends across all tenants. Per-number pacing is the rate
/// limiter's job; this only bounds database and connection use.
const OUTBOUND_CONCURRENCY = Number.parseInt(process.env.MESSAGING_OUTBOUND_CONCURRENCY ?? '5', 10) || 5;

@Processor(MESSAGING_OUTBOUND_QUEUE, { concurrency: OUTBOUND_CONCURRENCY })
export class OutboundProcessor extends WorkerHost {
    private readonly logger = new Logger(OutboundProcessor.name);

    constructor(
        private readonly sender: PlatformSenderService,
        private readonly prisma: PrismaService,
    ) {
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
            if (isRateLimitedError(err) && err.scope.kind === 'app') {
                // The app-wide wallet is shared by every tenant: pause the worker,
                // not just this job.
                await this.worker.rateLimit(Math.max(1_000, err.retryAtMs - Date.now()));
                throw Worker.RateLimitError();
            }
            if (!isRateLimitedError(err) && job.data.kind === 'deliver' && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
                await this.prisma.message.updateMany({
                    where: { id: job.data.messageId, status: MessageStatus.QUEUED },
                    data: {
                        status: MessageStatus.FAILED,
                        failedAt: new Date(),
                        errorMessage: 'Meta could not be reached. Try sending again.',
                    },
                });
            }
            await parkIfRateLimited(err, job, token, this.logger);
        }
    }
}
