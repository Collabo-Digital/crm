import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { InboxController } from './inbox.controller';
import { InboxMediaController } from './inbox-media.controller';
import { InboxService } from './inbox.service';
import { InboxMaintenance } from './inbox.maintenance';

@Module({
    imports: [MessagingModule],
    controllers: [InboxController, InboxMediaController],
    providers: [InboxService, InboxMaintenance],
})
export class InboxModule { }
