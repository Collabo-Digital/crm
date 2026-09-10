import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelService } from './channel.service';
import { ChannelController } from './channel.controller';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { ShopifyWebhookController } from './shopify-webhook.controller';
import { InstagramOAuthService } from './instagram-oauth.service';
import { InstagramWebhookController } from './instagram-webhook.controller';
import { WhatsAppOAuthService } from './whatsapp-oauth.service';
import { WhatsAppMessagingService } from './whatsapp-messaging.service';
import { WhatsAppMessagingProcessor } from './whatsapp.processor';
import { WhatsAppTriggerService } from './whatsapp-trigger.service';
import { ShopifySyncService } from './shopify-sync.service';
import { ShopifyLocationSyncService } from './shopify-location-sync.service';
import { ShopifyAnalyticsService } from './shopify-analytics.service';
import { ShopifyPushService } from './shopify-push.service';
import { ShopifyPushProcessor } from './shopify-push.processor';
import { ShopifyPushEnqueuer } from './shopify-push.enqueuer';
import { ShopifyGraphqlClient } from './shopify-graphql.client';
import { MetaGraphClient } from './meta-graph.client';
import { ShopifyPixelService } from './shopify-pixel.service';
import { SyncProcessor } from './sync.processor';
import { EncryptionService } from './encryption.service';
import { SYNC_QUEUE } from './sync.queue';
import { SHOPIFY_PUSH_QUEUE } from './shopify-push.queue';
import { WHATSAPP_MESSAGING_QUEUE } from './whatsapp.queue';
import { DRAFT_MIRROR_QUEUE } from '../draft-order/draft-mirror.queue';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { OrganizationSettingsModule } from '../organization-settings/organization-settings.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InvoiceModule } from '../invoice/invoice.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: SYNC_QUEUE }),
    BullModule.registerQueue({ name: SHOPIFY_PUSH_QUEUE }),
    BullModule.registerQueue({ name: WHATSAPP_MESSAGING_QUEUE }),
    // Register a reference to the draft-mirror queue so ShopifySyncService
    // can enqueue `bulk-mirror` trigger jobs without depending on the
    // DraftOrderModule (which already depends on us). BullMQ multi-registers
    // are safe — they share the same underlying Redis queue.
    BullModule.registerQueue({ name: DRAFT_MIRROR_QUEUE }),
    LoyaltyModule,
    OrganizationSettingsModule,
    // InventoryLedgerService — sync/webhook paths must respect the
    // warehousing flag and write ledger events. The reverse direction
    // (inventory → Shopify pushes) rides the shopify-push queue directly, so
    // no module cycle exists.
    InventoryModule,
    // InvoiceService — auto-issuing a GST invoice when a Shopify order becomes
    // paid. No cycle: InvoiceModule imports only GstModule, and nothing in the
    // invoice module reaches back into channels.
    InvoiceModule,
  ],
  controllers: [ChannelController, ShopifyWebhookController, InstagramWebhookController],
  providers: [
    ChannelService, ShopifyOAuthService, InstagramOAuthService, WhatsAppOAuthService,
    WhatsAppMessagingService, WhatsAppMessagingProcessor, WhatsAppTriggerService,
    ShopifySyncService, ShopifyLocationSyncService, ShopifyAnalyticsService, SyncProcessor, EncryptionService,
    ShopifyPushService, ShopifyPushProcessor, ShopifyPushEnqueuer,
    ShopifyGraphqlClient, MetaGraphClient, ShopifyPixelService,
  ],
  exports: [
    ChannelService, ShopifyOAuthService, InstagramOAuthService, WhatsAppOAuthService,
    WhatsAppMessagingService, WhatsAppTriggerService,
    ShopifySyncService, ShopifyLocationSyncService, ShopifyAnalyticsService, EncryptionService,
    ShopifyPushService, ShopifyPushEnqueuer,
    ShopifyGraphqlClient, MetaGraphClient,
  ],
})
export class ChannelModule { }
