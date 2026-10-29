import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentLinksService } from './payment-links.service';
import { WhatsAppPayService } from './whatsapp-pay.service';

/** Every 10 minutes: unpaid links and WhatsApp Pay requests whose webhook never arrived are checked. */
@Injectable()
export class PaymentLinksScheduler {
    constructor(
        private readonly links: PaymentLinksService,
        private readonly whatsAppPay: WhatsAppPayService,
    ) { }

    @Cron(CronExpression.EVERY_10_MINUTES)
    async sweep() {
        await this.links.sweep();
        await this.whatsAppPay.sweep();
    }
}
