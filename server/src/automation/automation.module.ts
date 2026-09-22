import { Module } from '@nestjs/common';
import { InstagramWebhookController } from './platforms/instagram/instagram-webhook.controller';
import { InstagramIngestService } from './platforms/instagram/instagram-ingest.service';
import { ContactService } from './messaging/contact.service';
import { MessageService } from './messaging/message.service';
import { AutomationEventService } from './automation-event.service';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';

@Module({
  controllers: [InstagramWebhookController, AutomationController],
  providers: [ContactService, MessageService, AutomationEventService, InstagramIngestService, AutomationService],
  exports: [ContactService, MessageService, AutomationEventService, AutomationService],
})
export class AutomationModule { }