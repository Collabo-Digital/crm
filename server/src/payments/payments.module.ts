import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelModule } from '../channel/channel.module';
import { TEMPLATE_PACK_QUEUE } from '../campaigns/templates/pack/template-pack.queue';
import { OrderModule } from '../order/order.module';
import { DraftOrderModule } from '../draft-order/draft-order.module';
import { CommerceModule } from '../commerce/commerce.module';
import { CommerceEventsModule } from '../commerce/commerce-events.module';
import { MessagingModule } from '../messaging/messaging.module';
import { PaymentsController } from './payments.controller';
import { RazorpayMerchantWebhookController } from './razorpay-merchant-webhook.controller';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentLinksService } from './payment-links.service';
import { PaymentLinksScheduler } from './payment-links.scheduler';
import { RazorpayMerchantClient } from './razorpay-merchant.client';
import { WhatsAppPayService } from './whatsapp-pay.service';
import { WhatsAppPayController } from './whatsapp-pay.controller';

/** Payment links paid into each organization's own Razorpay account, and WhatsApp Pay requests. */
@Module({
    imports: [
        ChannelModule,
        MessagingModule,
        OrderModule,
        DraftOrderModule,
        CommerceModule,
        CommerceEventsModule,
        // Razorpay connect adds the payment templates to Collabo's recommended
        // WhatsApp templates; their processor is in CampaignsModule.
        BullModule.registerQueue({ name: TEMPLATE_PACK_QUEUE }),
    ],
    controllers: [PaymentsController, RazorpayMerchantWebhookController, WhatsAppPayController],
    providers: [PaymentAccountsService, PaymentLinksService, PaymentLinksScheduler, RazorpayMerchantClient, WhatsAppPayService],
    exports: [PaymentAccountsService, PaymentLinksService, WhatsAppPayService],
})
export class PaymentsModule { }
