import { Module } from '@nestjs/common';
import { InstagramWebhookController } from './platforms/instagram/instagram-webhook.controller';
import { InstagramIngestService } from './platforms/instagram/instagram-ingest.service';
import { ContactService } from './messaging/contact.service';
import { MessageService } from './messaging/message.service';
import { AutomationEventService } from './automation-event.service';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { ChannelModule } from '../channel/channel.module';
import { InstagramMediaService } from './platforms/instagram/instagram-media.service';

@Module({
  imports: [ChannelModule],
  controllers: [InstagramWebhookController, AutomationController],
  providers: [ContactService, MessageService, AutomationEventService, InstagramIngestService, AutomationService, InstagramMediaService],
  exports: [ContactService, MessageService, AutomationEventService, AutomationService, InstagramMediaService],
})
export class AutomationModule { }