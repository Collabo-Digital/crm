import { Module } from '@nestjs/common';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';
import { ProductPublishScheduler } from './product-publish.scheduler';
import { ChannelModule } from '../channel/channel.module';
import { OrganizationSettingsModule } from '../organization-settings/organization-settings.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ImageStorageModule } from './image-storage/image-storage.module';

// WHY these imports?
//   ChannelModule              — ShopifyPushEnqueuer for fire-and-forget push.
//   OrganizationSettingsModule — gating auto-push on productSettings.autoSyncToShopify.
//   InventoryModule            — InventoryLedgerService: every quantity write is audited.
//   ImageStorageModule         — pluggable image storage; swap impl via UPLOAD_STORAGE env.
@Module({
  imports: [ChannelModule, OrganizationSettingsModule, InventoryModule, ImageStorageModule],
  controllers: [ProductController],
  providers: [ProductService, ProductPublishScheduler],
  exports: [ProductService],
})
export class ProductModule {}
