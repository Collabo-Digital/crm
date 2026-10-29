import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommerceEventsModule } from '../commerce/commerce-events.module';
import { AdsController } from './ads.controller';
import { AdsService } from './ads.service';

/** Click-to-message ads: referrals, results and the Conversions API. */
@Module({
    imports: [ChannelModule, MessagingModule, CommerceEventsModule],
    controllers: [AdsController],
    providers: [AdsService],
    exports: [AdsService],
})
export class AdsModule { }
