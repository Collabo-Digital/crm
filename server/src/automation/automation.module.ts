import { Module } from '@nestjs/common';
import { InstagramWebhookController } from './platforms/instagram/instagram-webhook.controller';

@Module({
  controllers: [InstagramWebhookController],
  providers: [],
})
export class AutomationModule { }