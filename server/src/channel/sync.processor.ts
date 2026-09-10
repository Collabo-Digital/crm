import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SyncStatus } from '@prisma/client';
import { SYNC_QUEUE, SyncJobData } from './sync.queue';
import { ShopifySyncService } from './shopify-sync.service';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { ShopifyPixelService } from './shopify-pixel.service';
import { PrismaService } from '../prisma/prisma.service';
import { parkIfRateLimited } from '../rate-limit/bullmq-park.util';
import { Priority } from '../rate-limit/rate-limit.types';

/// How many syncs may run at once. BullMQ's default is 1 — per queue, for the
/// whole deployment — so a single tenant's backfill blocked every other
/// tenant's sync behind it. Three fits comfortably inside the pool
/// (`connection_limit=10`) given each sync holds at most one interactive
/// transaction at a time.
const SYNC_CONCURRENCY = 3;

@Processor(SYNC_QUEUE, { concurrency: SYNC_CONCURRENCY })
export class SyncProcessor extends WorkerHost {
    private readonly logger = new Logger(SyncProcessor.name);

    constructor(
        private readonly syncService: ShopifySyncService,
        private readonly prisma: PrismaService,
        private readonly shopifyOAuth: ShopifyOAuthService,
        private readonly shopifyPixel: ShopifyPixelService,
    ) {
        super();
    }

    async process(job: Job<SyncJobData>, token?: string): Promise<void> {
        if (job.data.type === 'setup') {
            await this.runSetup(job);
            return;
        }

        const { channelId, organizationId, entityTypes } = job.data;
        const priority = (job.data.priority as Priority | undefined) ?? Priority.NORMAL;

        this.logger.log(
            `Processing sync job ${job.id}: channel=${channelId}, entities=[${entityTypes.join(',')}], p${priority}`,
        );

        try {
            await this.syncService.runSync(channelId, organizationId, entityTypes, priority);
        } catch (err) {
            // A rate limit mid-run parks the job (no attempt consumed) and the
            // per-entity cursors resume it later. Everything else rethrows.
            await parkIfRateLimited(err, job, token, this.logger);
        }

        this.logger.log(`Sync job ${job.id} completed`);
    }

    /**
     * Post-connect setup, moved off the HTTP request path.
     *
     * Both halves are best-effort and independently caught: a store with no
     * webhooks still syncs on demand, and the pixel is analytics-only. What we
     * must NOT do is fail the job for either, because BullMQ would then retry
     * the whole thing and re-issue 20 more mutations against a shop that is
     * very likely already rate-limited.
     */
    private async runSetup(job: Job<SyncJobData>): Promise<void> {
        const { channelId } = job.data;
        this.logger.log(`Running post-connect setup for channel ${channelId}`);

        try {
            await this.shopifyOAuth.registerWebhooks(channelId);
        } catch (error) {
            this.logger.warn(
                `Webhook registration failed for channel ${channelId} (non-fatal; " +
                "POST /channels/:id/register-webhooks re-runs it): ${error instanceof Error ? error.message : error}`,
            );
        }

        try {
            await this.shopifyPixel.activatePixel(channelId);
        } catch (error) {
            this.logger.warn(
                `Pixel activation failed for channel ${channelId} (non-fatal): ${error instanceof Error ? error.message : error}`,
            );
        }

        this.logger.log(`Setup job ${job.id} completed for channel ${channelId}`);
    }

    /**
     * Record a sync job that has given up for good.
     *
     * There was previously no failure handling anywhere in the server — no
     * worker event, no dead-letter queue, no alerting. Once BullMQ exhausted
     * `attempts`, the job landed in a failed set nobody reads and was evicted
     * after 50 more failures. The only trace was a log line.
     *
     * This fires ONLY on terminal exhaustion, not on each intermediate
     * attempt, so a transient blip that later succeeds does not mark the
     * channel broken. Everything it writes surfaces through endpoints that
     * already exist (`GET /channels/:id/sync-logs`, `channel.findOne`).
     */
    @OnWorkerEvent('failed')
    async onFailed(job: Job<SyncJobData> | undefined, err: Error): Promise<void> {
        if (!job) return;
        const maxAttempts = job.opts?.attempts ?? 1;
        if (job.attemptsMade < maxAttempts) {
            this.logger.warn(
                `Sync job ${job.id} attempt ${job.attemptsMade}/${maxAttempts} failed: ${err?.message ?? err} — will retry.`,
            );
            return;
        }

        const { channelId, organizationId } = job.data ?? {};
        this.logger.error(
            `Sync job ${job.id} for channel ${channelId} FAILED PERMANENTLY after ${job.attemptsMade} attempt(s): ${err?.message ?? err}`,
            err?.stack,
        );
        if (!channelId) return;

        try {
            // `errorDetails` is a Json column that has existed since the
            // schema was written and has never been populated.
            const latest = await this.prisma.syncLog.findFirst({
                where: { channelId },
                orderBy: { startedAt: 'desc' },
                select: { id: true },
            });
            if (latest) {
                await this.prisma.syncLog.update({
                    where: { id: latest.id },
                    data: {
                        status: SyncStatus.FAILED,
                        completedAt: new Date(),
                        errorMessage: err?.message ?? String(err),
                        errorDetails: {
                            jobId: String(job.id ?? ''),
                            attemptsMade: job.attemptsMade,
                            maxAttempts,
                            organizationId: organizationId ?? null,
                            name: err?.name ?? null,
                            stack: err?.stack?.split('\n').slice(0, 12).join('\n') ?? null,
                            failedAt: new Date().toISOString(),
                        },
                    },
                });
            }

            // `syncStatus` only. Setting `status: ERROR` here made a failed
            // backfill indistinguishable from a store we can no longer reach,
            // so the channels page showed "Error" for a store that was
            // connected and healthy. Genuine auth failures are handled in
            // runSync, which flips the channel to DISCONNECTED.
            await this.prisma.channel.update({
                where: { id: channelId },
                data: { syncStatus: SyncStatus.FAILED },
            });
        } catch (recordErr) {
            // Never let the reporting path throw — it would be swallowed by
            // BullMQ and we would lose the original failure too.
            this.logger.error(
                `Could not record the terminal failure of sync job ${job.id}`,
                recordErr instanceof Error ? recordErr.stack : recordErr,
            );
        }
    }
}
