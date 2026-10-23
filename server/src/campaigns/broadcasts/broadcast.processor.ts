import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BROADCAST_QUEUE, BroadcastJobData } from './broadcast.queue';
import { BroadcastsService } from './broadcasts.service';

@Processor(BROADCAST_QUEUE, { concurrency: 2 })
export class BroadcastProcessor extends WorkerHost {
    private readonly logger = new Logger(BroadcastProcessor.name);

    constructor(private readonly broadcasts: BroadcastsService) {
        super();
    }

    async process(job: Job<BroadcastJobData>): Promise<void> {
        const data = job.data;
        try {
            switch (data.kind) {
                case 'start':
                    return await this.broadcasts.start(data.broadcastId);
                case 'send':
                    return await this.broadcasts.sendBatch(data.broadcastId, data.recipientIds);
                case 'finish':
                    return await this.broadcasts.finishIfDone(data.broadcastId, data.attempt);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // A start that keeps failing (say, the header file will not upload) fails the broadcast.
            if (data.kind === 'start' && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
                await this.broadcasts.fail(data.broadcastId, `Sending could not start: ${message}`);
            }
            this.logger.warn(`Broadcast job ${data.kind} for ${data.broadcastId} failed: ${message}`);
            throw err;
        }
    }
}
