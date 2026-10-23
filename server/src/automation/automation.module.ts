import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { ChannelModule } from '../channel/channel.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { InstagramMediaService } from './platforms/instagram/instagram-media.service';
import { META_INBOUND_QUEUE } from './platforms/meta/meta-inbound.queue';
import { MetaWebhookController } from './platforms/meta/meta-webhook.controller';
import { MetaWebhookIntakeService } from './platforms/meta/meta-webhook-intake.service';
import { MetaInboundRouter } from './platforms/meta/meta-inbound.router';
import { MetaInboundProcessor } from './platforms/meta/meta-inbound.processor';
import { MetaWebhookMaintenance } from './platforms/meta/meta-webhook.maintenance';
import { WhatsAppWebhookHandler } from './platforms/whatsapp/whatsapp-webhook.handler';
import { MessengerWebhookHandler } from './platforms/messenger/messenger-webhook.handler';
import { InboxModule } from '../inbox/inbox.module';
import { CommerceModule } from '../commerce/commerce.module';
import { PaymentsModule } from '../payments/payments.module';
import { AUTOMATION_QUEUE } from '../messaging/automation-jobs';
import { AutomationDispatcher } from './engine/automation-dispatcher.service';
import { AutomationRunner } from './engine/automation-runner.service';
import { AutomationProcessor, AutomationSweeper } from './engine/automation.processor';
import { AutomationInsightsService } from './automation-insights.service';
import { AutomationHooksService } from './automation-hooks.service';
import { AutomationHooksController } from './automation-hooks.controller';
import { ConversationStartersService } from './conversation-starters.service';

@Module({
  imports: [
    ChannelModule, MessagingModule, CampaignsModule, InboxModule, CommerceModule, PaymentsModule,
    BullModule.registerQueue({ name: META_INBOUND_QUEUE }),
    BullModule.registerQueue({ name: AUTOMATION_QUEUE }),
  ],
  controllers: [MetaWebhookController, AutomationHooksController, AutomationController],
  providers: [
    AutomationService, InstagramMediaService,
    MetaWebhookIntakeService, MetaInboundRouter, MetaInboundProcessor, MetaWebhookMaintenance,
    WhatsAppWebhookHandler, MessengerWebhookHandler,
    AutomationDispatcher, AutomationRunner, AutomationProcessor, AutomationSweeper,
    AutomationInsightsService, AutomationHooksService, ConversationStartersService,
  ],
  exports: [AutomationService, InstagramMediaService],
})
export class AutomationModule { }
