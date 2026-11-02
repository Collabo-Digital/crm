import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommerceEventsModule } from '../commerce/commerce-events.module';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyGuard } from './api-key.guard';
import { DeveloperController } from './developer.controller';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { WEBHOOK_QUEUE, WebhooksService } from './webhooks.service';
import { WebhooksProcessor } from './webhooks.processor';

/** The public API (keys) and outgoing webhooks. */
@Module({
    imports: [ChannelModule, MessagingModule, CommerceEventsModule, BullModule.registerQueue({ name: WEBHOOK_QUEUE })],
    controllers: [DeveloperController, PublicApiController],
    providers: [ApiKeysService, ApiKeyGuard, PublicApiService, WebhooksService, WebhooksProcessor],
    exports: [WebhooksService],
})
export class DeveloperModule { }
