import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SHOPIFY_PUSH_QUEUE, ShopifyPushJobData } from './shopify-push.queue';
import { ShopifyPushService } from './shopify-push.service';
import { ShopifyPushEnqueuer } from './shopify-push.enqueuer';
import { ShopifyLocationSyncService } from './shopify-location-sync.service';
import { parkIfRateLimited } from '../rate-limit/bullmq-park.util';
import { Priority, isRateLimitedError } from '../rate-limit/rate-limit.types';

/// How many push jobs may run at once, across every tenant. BullMQ's default
/// is 1, so one merchant's bulk push blocked every other merchant's single
/// order push behind it. Read from the environment directly because a
/// decorator argument is evaluated before Nest's ConfigService exists.
///
/// Pool arithmetic: sync 3 + push 3 + whatsapp 3 + draft 1 + inventory 1 = 11
/// slots against `connection_limit=10`. Each push holds a connection only
/// during short Prisma calls and Prisma queues on `pool_timeout` rather than
/// failing, so this is safe — but raise `pool_timeout` alongside it, and do
/// not go higher without raising `connection_limit`.
const PUSH_CONCURRENCY = Number.parseInt(process.env.SHOPIFY_PUSH_CONCURRENCY ?? '3', 10) || 3;

@Processor(SHOPIFY_PUSH_QUEUE, { concurrency: PUSH_CONCURRENCY })
export class ShopifyPushProcessor extends WorkerHost {
  private readonly logger = new Logger(ShopifyPushProcessor.name);

  constructor(
    private readonly pushService: ShopifyPushService,
    private readonly enqueuer: ShopifyPushEnqueuer,
    private readonly locationSync: ShopifyLocationSyncService,
  ) {
    super();
  }

  async process(job: Job<ShopifyPushJobData>, token?: string): Promise<void> {
    const data = job.data;
    const priority = (data.priority as Priority | undefined) ?? Priority.NORMAL;

    this.logger.log(
      `Push job ${job.id} (${data.type}, p${priority}) attempt ${job.attemptsMade + 1}`,
    );

    try {
      switch (data.type) {
        case 'order':
          await this.pushService.pushOrder(data.orderId, data.organizationId, priority);
          break;
        case 'product':
          await this.pushService.pushProduct(data.productId, data.organizationId, priority);
          break;
        case 'bulk-products': {
          // Planner: list, fan out, done. The worker slot is free again in
          // milliseconds instead of for the whole catalogue.
          const ids = await this.pushService.planBulkProductPush(data.organizationId);
          const n = await this.enqueuer.enqueueProductPushMany(
            data.organizationId,
            ids,
            Priority.BULK,
            String(job.id),
          );
          this.logger.log(`Bulk product plan for org ${data.organizationId}: ${n} job(s) queued.`);
          break;
        }
        case 'bulk-orders': {
          const ids = await this.pushService.planBulkOrderPush(data.organizationId);
          const n = await this.enqueuer.enqueueOrderPushMany(
            data.organizationId,
            ids,
            Priority.BULK,
            String(job.id),
          );
          this.logger.log(`Bulk order plan for org ${data.organizationId}: ${n} job(s) queued.`);
          break;
        }
        case 'push-availability':
          await this.pushService.pushAvailability(
            data.organizationId,
            data.variantIds,
            priority,
          );
          break;
        case 'sync-locations':
          await this.locationSync.runForOrganization(data.organizationId);
          break;
        default: {
          // Exhaustiveness check — if a new job type is added without a
          // case here, TS will flag it.
          const _exhaustive: never = data;
          throw new Error(`Unknown push job type: ${JSON.stringify(_exhaustive)}`);
        }
      }
    } catch (err) {
      // A rate limit is not a failure: park the job until the limiter said
      // to retry, without burning an attempt or stamping "Sync failed" on the
      // entity. Anything else falls through to the failure path below.
      await parkIfRateLimited(err, job, token, this.logger).catch((parkedOrOriginal) => {
        if (parkedOrOriginal === err) return; // rethrown untouched: real failure
        throw parkedOrOriginal; // DelayedError: BullMQ knows we moved it
      });
      // No worker token to park with (should not happen under BullMQ): let
      // the ordinary backoff retry it, but never stamp a throttle on the
      // entity as if the push itself had failed.
      if (isRateLimitedError(err)) throw err;

      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Push job ${job.id} (${data.type}) failed: ${msg}`);

      // Persist failure on the relevant entity's metadata so the merchant
      // can see the error in the UI.
      if (data.type === 'order') {
        await this.pushService
          .recordFailure(data.orderId, data.organizationId, msg, !!data.bulkRunId)
          .catch(() => undefined);
      } else if (data.type === 'product') {
        await this.pushService
          .recordProductFailure(data.productId, data.organizationId, msg)
          .catch(() => undefined);
      }

      throw err; // bubble so BullMQ applies its retry policy
    }
  }

  /**
   * Terminal failures only — fires after the last attempt, never on a parked
   * job (BullMQ does not count `DelayedError` as a failure).
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<ShopifyPushJobData> | undefined, err: Error): void {
    if (!job) return;
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;
    this.logger.error(
      JSON.stringify({
        event: 'shopify_push.exhausted',
        jobId: job.id,
        type: job.data?.type,
        organizationId: job.data?.organizationId,
        bulkRunId: job.data?.bulkRunId,
        attempts: job.attemptsMade,
        error: err?.message ?? String(err),
      }),
    );
  }
}
