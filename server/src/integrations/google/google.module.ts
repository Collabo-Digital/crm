import { Module } from '@nestjs/common';
import { ChannelModule } from '../../channel/channel.module';
import { GoogleClient } from './google.client';
import { GoogleController } from './google.controller';
import { GoogleService } from './google.service';

/** Google Sheets for automations, with each organization's own Google account. */
@Module({
    imports: [ChannelModule],
    controllers: [GoogleController],
    providers: [GoogleService, GoogleClient],
    exports: [GoogleService],
})
export class GoogleModule { }
