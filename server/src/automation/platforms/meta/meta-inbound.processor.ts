import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { META_INBOUND_QUEUE, MetaInboundJobData } from './meta-inbound.queue';
import { MetaInboundRouter } from './meta-inbound.router';

/// Deliveries processed at once across all tenants. Each is a handful of
/// short transactions, so a few in parallel keeps up with Meta's bursts
/// without crowding the shared connection pool.
const META_INBOUND_CONCURRENCY =
    Number.parseInt(process.env.META_INBOUND_CONCURRENCY ?? '4', 10) || 4;

@Processor(META_INBOUND_QUEUE, { concurrency: META_INBOUND_CONCURRENCY })
export class MetaInboundProcessor extends WorkerHost {
    private readonly logger = new Logger(MetaInboundProcessor.name);

    constructor(private readonly router: MetaInboundRouter) {
        super();
    }

    async process(job: Job<MetaInboundJobData>): Promise<void> {
        const outcome = await this.router.process(job.data.deliveryId);
        if (outcome === 'processed') this.logger.debug(`Meta delivery ${job.data.deliveryId} processed`);
    }
}
