import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { GrowthController } from './growth.controller';
import { GrowthPublicController } from './growth-public.controller';
import { GrowthService } from './growth.service';

/** Chat links, QR codes, and the website chat button and pop-up. */
@Module({
    imports: [MessagingModule],
    controllers: [GrowthController, GrowthPublicController],
    providers: [GrowthService],
    exports: [GrowthService],
})
export class GrowthModule { }
