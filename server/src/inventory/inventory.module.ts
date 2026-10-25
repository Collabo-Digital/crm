import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrganizationSettingsModule } from '../organization-settings/organization-settings.module';
import { InventoryLedgerService } from './inventory-ledger.service';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { WarehouseService } from './warehouse.service';
import { WarehouseController } from './warehouse.controller';
import { SkuGeneratorService } from './sku-generator.service';
import { InventoryProcessor } from './inventory.processor';
import { LocationsSwitchOver } from './locations-switch-over';
import { LocationLinkService } from './location-links.service';
import { INVENTORY_QUEUE } from './inventory.queue';
import { SHOPIFY_PUSH_QUEUE } from '../channel/shopify-push.queue';

/**
 * Inventory V1 (warehousing), Phase A: movement ledger (shared with
 * ProductModule + ChannelModule so every quantity write is audited), stock
 * screen endpoints, adjustments, enable-seed flow, SKU/barcode generation,
 * warehouse + location management.
 *
 * Module topology note: ChannelModule imports THIS module (sync/webhook paths
 * need the ledger + warehousing flag). The reverse direction — availability
 * pushes to Shopify — deliberately rides the shopify-push QUEUE by name
 * (BullMQ multi-registration shares the Redis queue) instead of importing
 * ChannelModule, keeping the graph acyclic.
 */
@Module({
  imports: [
    OrganizationSettingsModule,
    BullModule.registerQueue({ name: INVENTORY_QUEUE }),
    BullModule.registerQueue({ name: SHOPIFY_PUSH_QUEUE }),
  ],
  controllers: [InventoryController, WarehouseController],
  providers: [
    InventoryLedgerService,
    InventoryService,
    WarehouseService,
    SkuGeneratorService,
    InventoryProcessor,
    LocationsSwitchOver,
    LocationLinkService,
  ],
  exports: [InventoryLedgerService, SkuGeneratorService, LocationLinkService],
})
export class InventoryModule {}
