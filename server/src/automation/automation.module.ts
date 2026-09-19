import { Module } from '@nestjs/common';
import { InstagramWebhookController } from './platforms/instagram/instagram-webhook.controller';
import { InstagramIngestService } from './platforms/instagram/instagram-ingest.service';
import { ContactService } from './messaging/contact.service';
import { MessageService } from './messaging/message.service';
import { AutomationEventService } from './automation-event.service';

@Module({
  controllers: [InstagramWebhookController],
  providers: [ContactService, MessageService, AutomationEventService, InstagramIngestService],
  exports: [ContactService, MessageService, AutomationEventService],
})
export class AutomationModule { }