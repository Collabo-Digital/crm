import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { OrderModule } from '../order/order.module';
import { DraftOrderModule } from '../draft-order/draft-order.module';
import { CommerceModule } from '../commerce/commerce.module';
import { CommerceEventsModule } from '../commerce/commerce-events.module';
import { PaymentsController } from './payments.controller';
import { RazorpayMerchantWebhookController } from './razorpay-merchant-webhook.controller';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentLinksService } from './payment-links.service';
import { PaymentLinksScheduler } from './payment-links.scheduler';
import { RazorpayMerchantClient } from './razorpay-merchant.client';

/** Payment links paid into each organization's own Razorpay account. */
@Module({
    imports: [ChannelModule, OrderModule, DraftOrderModule, CommerceModule, CommerceEventsModule],
    controllers: [PaymentsController, RazorpayMerchantWebhookController],
    providers: [PaymentAccountsService, PaymentLinksService, PaymentLinksScheduler, RazorpayMerchantClient],
    exports: [PaymentAccountsService, PaymentLinksService],
})
export class PaymentsModule { }
