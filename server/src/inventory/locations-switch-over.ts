import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { INVENTORY_QUEUE, InventoryJobData, switchOverJobId } from './inventory.queue';

const SWITCH_OVER_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { age: 60 * 60 * 24 * 30 },
  removeOnFail: { age: 60 * 60 * 24 * 30 },
};

/**
 * Moves every workspace still on a single stock quantity to stock locations,
 * once, from application start-up (LOCATIONS_AUTO_ENABLE, on by default).
 *
 * Each workspace is one `switch-over` job on the inventory queue, which runs
 * one job at a time — so a deploy works through the workspaces in turn rather
 * than seeding all of them at once. The job id is the workspace's, so several
 * servers starting together queue it once; one that finished or gave up is
 * replaced, so a workspace whose switch failed is tried again on the next
 * start, while one that switched is no longer selected at all.
 */
@Injectable()
export class LocationsSwitchOver implements OnApplicationBootstrap {
  private readonly logger = new Logger(LocationsSwitchOver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(INVENTORY_QUEUE)
    private readonly inventoryQueue: Queue<InventoryJobData>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<boolean>('inventory.locationsAutoEnable') === false) return;
    // Not awaited: start-up must not wait on, or fail with, the queue.
    void this.enqueueAll().catch((err) =>
      this.logger.error(
        `Could not queue the switch to stock locations; the next start tries again: ${err instanceof Error ? err.message : err}`,
      ),
    );
  }

  /** Queues a switch for every workspace without stock locations. Returns how many were queued. */
  async enqueueAll(): Promise<number> {
    const pending = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT o."id"
      FROM "organizations" o
      LEFT JOIN "organization_settings" s ON s."organization_id" = o."id"
      WHERE o."deleted_at" IS NULL
        AND COALESCE(s."inventory_settings"->>'warehousingEnabled', 'false') <> 'true'
      ORDER BY o."created_at"
    `;
    let queued = 0;
    for (const { id } of pending) {
      const jobId = switchOverJobId(id);
      const existing = await this.inventoryQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state !== 'completed' && state !== 'failed') continue;
        await existing.remove();
      }
      await this.inventoryQueue.add(
        'switch-over',
        { type: 'switch-over', organizationId: id },
        { ...SWITCH_OVER_JOB_OPTS, jobId },
      );
      queued++;
    }
    if (queued > 0) {
      this.logger.log(`Queued the switch to stock locations for ${queued} workspace(s).`);
    }
    return queued;
  }
}
