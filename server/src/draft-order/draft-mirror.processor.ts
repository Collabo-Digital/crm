import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DRAFT_MIRROR_QUEUE, DraftMirrorJobData } from './draft-mirror.queue';
import { DraftOrderService } from './draft-order.service';
import { parkIfRateLimited } from '../rate-limit/bullmq-park.util';

/**
 * BullMQ worker for draft → Shopify mirroring. Reads the current state
 * of the draft on every run (so multiple coalesced jobs converge on the
 * latest state) and delegates to the service's mirror methods.
 *
 * Failures bubble back to BullMQ for its retry policy; the service-level
 * methods themselves don't catch their own errors (caller decides whether
 * to swallow or retry). A rate limit from the outbound limiter is not a
 * failure: the job is parked until the limiter's retry time instead.
 */
@Processor(DRAFT_MIRROR_QUEUE)
export class DraftMirrorProcessor extends WorkerHost {
  private readonly logger = new Logger(DraftMirrorProcessor.name);

  constructor(private readonly draftOrderService: DraftOrderService) {
    super();
  }

  async process(job: Job<DraftMirrorJobData>, token?: string): Promise<void> {
    const data = job.data;
    this.logger.log(
      `Draft mirror job ${job.id} (${data.type}) attempt ${
        job.attemptsMade + 1
      }`,
    );

    try {
      switch (data.type) {
        case 'draft-create':
          await this.draftOrderService.mirrorCreateToShopify(
            data.draftId,
            data.organizationId,
          );
          break;
        case 'draft-update':
          await this.draftOrderService.mirrorUpdateToShopify(
            data.draftId,
            data.organizationId,
          );
          break;
        case 'draft-delete':
          await this.draftOrderService.mirrorDeleteToShopify(
            data.externalId,
            data.organizationId,
          );
          break;
        case 'bulk-mirror':
          await this.draftOrderService.bulkMirrorUnsyncedDrafts(
            data.organizationId,
          );
          break;
        default: {
          // Exhaustiveness check — TS flags new job types not handled here.
          const _exhaustive: never = data;
          throw new Error(`Unknown draft mirror job type: ${JSON.stringify(_exhaustive)}`);
        }
      }
    } catch (err) {
      await parkIfRateLimited(err, job, token, this.logger);
    }
  }
}
