import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AUTOMATION_QUEUE, AutomationJobs } from '../messaging/automation-jobs';
import { CheckoutService } from './checkout.service';
import { CommerceEventsService } from './commerce-events.service';

/**
 * Store events for automations. Depends on nothing but Prisma and the
 * automation queue, so the channel (Shopify) and order modules can raise
 * events without importing the messaging stack.
 */
@Module({
    imports: [BullModule.registerQueue({ name: AUTOMATION_QUEUE })],
    providers: [AutomationJobs, CommerceEventsService, CheckoutService],
    exports: [CommerceEventsService, CheckoutService],
})
export class CommerceEventsModule { }
