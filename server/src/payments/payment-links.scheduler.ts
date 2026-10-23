import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentLinksService } from './payment-links.service';

/** Every 10 minutes: unpaid links whose webhook never arrived are checked with Razorpay. */
@Injectable()
export class PaymentLinksScheduler {
    constructor(private readonly links: PaymentLinksService) { }

    @Cron(CronExpression.EVERY_10_MINUTES)
    sweep() {
        return this.links.sweep();
    }
}
