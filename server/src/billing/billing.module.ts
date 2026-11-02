import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module';
import { BillingAccessService } from './billing-access';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingReconciler } from './billing.reconciler';
import { BillingUsageController } from './billing-usage.controller';
import { RazorpayService } from './razorpay.service';
import { UsageBillingService } from './usage-billing.service';
import { UsageMeter } from './usage-meter';
import { UsageService } from './usage.service';
import { RazorpayWebhookController } from './webhooks/razorpay-webhook.controller';

@Module({
    imports: [ConfigModule, PrismaModule],
    controllers: [BillingController, BillingUsageController, RazorpayWebhookController],
    providers: [BillingService, BillingAccessService, RazorpayService, BillingReconciler, UsageMeter, UsageService, UsageBillingService],
    exports: [BillingService, BillingAccessService, UsageMeter],
})
export class BillingModule { }
