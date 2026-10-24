import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelModule } from '../channel/channel.module';
import { BillingModule } from '../billing/billing.module';
import { AutomationEventService } from './automation-event.service';
import { BroadcastTracker } from './broadcast-tracker';
import { AUTOMATION_QUEUE, AutomationJobs } from './automation-jobs';
import { ChannelAccessService } from './channel-access.service';
import { ConsentService } from './consent.service';
import { ContactIdentityService } from './contact-identity.service';
import { ContactProfileService } from './contact-profile.service';
import { InboxEventsService } from './inbox-events.service';
import { MessageIngestService } from './message-ingest.service';
import { MEDIA_DOWNLOAD_QUEUE } from './media/media-download.queue';
import { MediaDownloadProcessor } from './media/media-download.processor';
import { MediaDownloadService } from './media/media-download.service';
import { MessagingMediaStorage } from './media/messaging-media.storage';
import { MESSAGING_OUTBOUND_QUEUE } from './send/outbound.queue';
import { MessagingSendService } from './send/messaging-send.service';
import { OutboundProcessor } from './send/outbound.processor';
import { OutboundSweeper } from './send/outbound.sweeper';
import { PlatformSenderService } from './send/platform-sender.service';

/**
 * The shared messaging core: contacts, conversations and messages for
 * WhatsApp, Messenger and Instagram, written by the webhook handlers, read by
 * the inbox, and sent through by the inbox, automations and broadcasts.
 */
@Module({
    imports: [
        ChannelModule,
        BillingModule,
        BullModule.registerQueue({ name: MEDIA_DOWNLOAD_QUEUE }),
        BullModule.registerQueue({ name: MESSAGING_OUTBOUND_QUEUE }),
        BullModule.registerQueue({ name: AUTOMATION_QUEUE }),
    ],
    providers: [
        AutomationEventService,
        AutomationJobs,
        BroadcastTracker,
        ChannelAccessService,
        ConsentService,
        ContactIdentityService,
        ContactProfileService,
        InboxEventsService,
        MessageIngestService,
        MediaDownloadService,
        MediaDownloadProcessor,
        MessagingMediaStorage,
        MessagingSendService,
        OutboundProcessor,
        OutboundSweeper,
        PlatformSenderService,
    ],
    exports: [
        AutomationEventService,
        AutomationJobs,
        BroadcastTracker,
        ChannelAccessService,
        ConsentService,
        ContactIdentityService,
        InboxEventsService,
        MessageIngestService,
        MessagingMediaStorage,
        MessagingSendService,
        PlatformSenderService,
    ],
})
export class MessagingModule { }
