import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelModule } from '../channel/channel.module';
import { MessagingModule } from '../messaging/messaging.module';
import { BROADCAST_QUEUE } from './broadcasts/broadcast.queue';
import { BroadcastProcessor } from './broadcasts/broadcast.processor';
import { BroadcastsController } from './broadcasts/broadcasts.controller';
import { BroadcastsService } from './broadcasts/broadcasts.service';
import { CampaignsOverviewService } from './overview/campaigns-overview.service';
import { MessageRatesService } from './rates/message-rates.service';
import { RfmService } from './segments/rfm.service';
import { SegmentsController } from './segments/segments.controller';
import { SegmentsService } from './segments/segments.service';
import { ShopifySegmentsService } from './segments/shopify-segments.service';
import { ShopifySegmentsController } from './segments/shopify-segments.controller';
import { TemplateSyncScheduler } from './templates/template-sync.scheduler';
import { TemplatesController } from './templates/templates.controller';
import { TemplatesService } from './templates/templates.service';

/**
 * Campaigns: WhatsApp templates, audience segments and broadcasts. The
 * automation builder (M5) joins them here.
 */
@Module({
    imports: [ChannelModule, MessagingModule, BullModule.registerQueue({ name: BROADCAST_QUEUE })],
    controllers: [TemplatesController, SegmentsController, ShopifySegmentsController, BroadcastsController],
    providers: [
        TemplatesService,
        TemplateSyncScheduler,
        SegmentsService,
        RfmService,
        ShopifySegmentsService,
        BroadcastsService,
        BroadcastProcessor,
        MessageRatesService,
        CampaignsOverviewService,
    ],
    exports: [TemplatesService, SegmentsService],
})
export class CampaignsModule { }
