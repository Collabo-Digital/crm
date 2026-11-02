import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelModule } from '../channel/channel.module';
import { AUTOMATION_QUEUE } from '../messaging/automation-jobs';
import { MessagingModule } from '../messaging/messaging.module';
import { BROADCAST_QUEUE } from './broadcasts/broadcast.queue';
import { BroadcastMaintenance } from './broadcasts/broadcast.maintenance';
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
import { TemplateWriterService } from './templates/template-writer.service';
import { TemplatesService } from './templates/templates.service';
import { PublicLinksController } from './templates/pack/public-links.controller';
import { PublicLinksService } from './templates/pack/public-links.service';
import { TemplatePackBackfill } from './templates/pack/template-pack.backfill';
import { TemplatePackJobs } from './templates/pack/template-pack-jobs';
import { TemplatePackProcessor } from './templates/pack/template-pack.processor';
import { TEMPLATE_PACK_QUEUE } from './templates/pack/template-pack.queue';
import { TemplatePackService } from './templates/pack/template-pack.service';

/**
 * Campaigns: WhatsApp templates, audience segments and broadcasts. The
 * automation builder (M5) joins them here.
 */
@Module({
    imports: [
        ChannelModule,
        MessagingModule,
        BullModule.registerQueue(
            { name: BROADCAST_QUEUE },
            { name: TEMPLATE_PACK_QUEUE },
            // The pack queues the engine's managed-sync; the engine sits above this module.
            { name: AUTOMATION_QUEUE },
        ),
    ],
    controllers: [TemplatesController, PublicLinksController, SegmentsController, ShopifySegmentsController, BroadcastsController],
    providers: [
        TemplatesService,
        TemplatePackJobs,
        TemplatePackService,
        TemplatePackProcessor,
        TemplatePackBackfill,
        PublicLinksService,
        TemplateWriterService,
        TemplateSyncScheduler,
        SegmentsService,
        RfmService,
        ShopifySegmentsService,
        BroadcastsService,
        BroadcastProcessor,
        BroadcastMaintenance,
        MessageRatesService,
        CampaignsOverviewService,
    ],
    exports: [TemplatesService, SegmentsService],
})
export class CampaignsModule { }
