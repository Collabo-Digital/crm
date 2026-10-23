import { Module } from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderController } from './order.controller';
import { GstModule } from '../gst/gst.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { ChannelModule } from '../channel/channel.module';
import { OrganizationSettingsModule } from '../organization-settings/organization-settings.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { InventoryModule } from '../inventory/inventory.module';
import { BullModule } from '@nestjs/bullmq';
import { SHOPIFY_PUSH_QUEUE } from '../channel/shopify-push.queue';
import { CommerceEventsModule } from '../commerce/commerce-events.module';

// WHY these imports?
//   GstModule                  — tax math (GstCalculatorService, TaxResolverService).
//   InvoiceModule              — auto-generate the bill in the same transaction.
//   ChannelModule              — push the offline order to Shopify post-commit (via
//                                 ShopifyPushEnqueuer + ShopifyPushService).
//   OrganizationSettingsModule — gating auto-push on orderSettings.autoSyncToShopify.
//   LoyaltyModule              — offline sales and cancellations move
//                                 Customer.ordersCount / totalSpent, and the VIP
//                                 tier is derived from them.
@Module({
  imports: [
    GstModule,
    InvoiceModule,
    ChannelModule,
    OrganizationSettingsModule,
    LoyaltyModule,
    InventoryModule,
    // Order events for automations (no cycle: it depends only on Prisma and a queue).
    CommerceEventsModule,
    // Cancelling a MANUAL order restocks into a warehouse bucket, and the new
    // quantity has to reach Shopify. Registering the queue by name rather than
    // importing a Shopify service keeps this the same cycle-free seam
    // InventoryModule uses for its own availability pushes.
    BullModule.registerQueue({ name: SHOPIFY_PUSH_QUEUE }),
  ],
  controllers: [OrderController],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrderModule {}
