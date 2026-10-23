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

@Module({
  imports: [ChannelModule, MessagingModule, CampaignsModule, BullModule.registerQueue({ name: META_INBOUND_QUEUE })],
  controllers: [MetaWebhookController, AutomationController],
  providers: [
    AutomationService, InstagramMediaService,
    MetaWebhookIntakeService, MetaInboundRouter, MetaInboundProcessor, MetaWebhookMaintenance,
    WhatsAppWebhookHandler, MessengerWebhookHandler,
  ],
  exports: [AutomationService, InstagramMediaService],
})
export class AutomationModule { }
