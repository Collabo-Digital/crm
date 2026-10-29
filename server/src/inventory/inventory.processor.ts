import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { INVENTORY_QUEUE, InventoryJobData } from './inventory.queue';
import { InventoryService } from './inventory.service';

@Processor(INVENTORY_QUEUE)
export class InventoryProcessor extends WorkerHost {
  private readonly logger = new Logger(InventoryProcessor.name);

  constructor(private readonly inventory: InventoryService) {
    super();
  }

  async process(job: Job<InventoryJobData>): Promise<void> {
    const data = job.data;
    this.logger.log(
      `Inventory job ${job.id} (${data.type}) attempt ${job.attemptsMade + 1}`,
    );
    switch (data.type) {
      case 'enable-seed':
        await this.inventory.runEnableSeed(data.organizationId, data.userId);
        break;
      case 'switch-over':
        await this.inventory.runSwitchOver(data.organizationId);
        break;
      default: {
        const _exhaustive: never = data;
        throw new Error(`Unknown inventory job type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
