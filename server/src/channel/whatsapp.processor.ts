import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { WHATSAPP_MESSAGING_QUEUE, WhatsAppMessageJobData } from './whatsapp.queue';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';
import { parkIfRateLimited } from '../rate-limit/bullmq-park.util';
import { isRateLimitedError } from '../rate-limit/rate-limit.types';

/// Concurrent sends across all tenants. See ShopifyPushProcessor for the DB
/// pool arithmetic these numbers were chosen against.
const WHATSAPP_CONCURRENCY =
    Number.parseInt(process.env.WHATSAPP_MESSAGING_CONCURRENCY ?? '3', 10) || 3;

/**
 * BullMQ worker for the WhatsApp messaging queue.
 * Jobs are enqueued by WhatsAppTriggerService; this worker dispatches them to
 * Meta's Cloud API via WhatsAppMessagingService.
 *
 * Failures thrown from the service bubble up to BullMQ, which retries with
 * exponential backoff per the `attempts` + `backoff` options set at enqueue time.
 *
 * Rate limits are not failures. A limit on the merchant's own wallets (their
 * WABA or phone number) parks just this job. A limit on the APP wallet
 * affects every merchant, so the whole worker pauses until it reopens — no
 * point pulling the next tenant's job into the same closed door.
 */
@Processor(WHATSAPP_MESSAGING_QUEUE, { concurrency: WHATSAPP_CONCURRENCY })
export class WhatsAppMessagingProcessor extends WorkerHost {
    private readonly logger = new Logger(WhatsAppMessagingProcessor.name);

    constructor(private readonly messagingService: WhatsAppMessagingService) {
        super();
    }

    async process(job: Job<WhatsAppMessageJobData>, token?: string): Promise<void> {
        const { toPhone, templateName, triggerType } = job.data;
        this.logger.log(
            `Processing WhatsApp job ${job.id}: ${templateName} → ${toPhone} (trigger=${triggerType})`,
        );

        try {
            await this.messagingService.sendTemplate(job.data);
        } catch (err) {
            if (isRateLimitedError(err) && err.scope.kind === 'app') {
                const ms = Math.max(1_000, err.retryAtMs - Date.now());
                this.logger.warn(
                    JSON.stringify({
                        event: 'rate_limit.worker_paused',
                        queue: WHATSAPP_MESSAGING_QUEUE,
                        scope: `${err.scope.platform}:${err.scope.kind}:${err.scope.id}`,
                        ms,
                    }),
                );
                await this.worker.rateLimit(ms);
                // BullMQ moves the job back to waiting without counting an attempt.
                throw Worker.RateLimitError();
            }
            await parkIfRateLimited(err, job, token, this.logger);
        }

        this.logger.log(`WhatsApp job ${job.id} completed`);
    }
}
