import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { WEBHOOK_QUEUE, WebhooksService } from './webhooks.service';

@Processor(WEBHOOK_QUEUE, { concurrency: 10 })
export class WebhooksProcessor extends WorkerHost {
    constructor(private readonly webhooks: WebhooksService) {
        super();
    }

    async process(job: Job<{ deliveryId: string }>): Promise<void> {
        const attempt = job.attemptsMade + 1;
        await this.webhooks.deliver(job.data.deliveryId, attempt, attempt >= (job.opts.attempts ?? 1));
    }
}
