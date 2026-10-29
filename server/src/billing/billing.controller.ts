import { Body, Controller, Get, Post } from '@nestjs/common';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NoOrgRequired } from '../auth/decorators/no-org-required.decorator';
import { BillingService } from './billing.service';
import { RazorpayService } from './razorpay.service';
import { StartOnboardingCheckoutDto } from './dto/start-onboarding-checkout.dto';

// JWT is enforced globally by JwtAuthGuard (see app.module.ts).
// @NoOrgRequired: onboarding checkout runs before the user has an org.
@Controller('billing')
@NoOrgRequired()
export class BillingController {
    constructor(
        private readonly billing: BillingService,
        private readonly razorpay: RazorpayService,
    ) { }

    /** Client fetches this once before mounting Razorpay Checkout.js. */
    @Get('config')
    getConfig() {
        return { razorpayKeyId: this.razorpay.getKeyId() };
    }

    /** The plans and their prices, in rupees and dollars. */
    @Get('plans')
    getPlans() {
        return this.billing.plans();
    }

    /** Called when the user clicks Continue on /onboarding/choose-plan. */
    @Post('onboarding-checkout')
    startOnboardingCheckout(
        @CurrentUser() user: JwtPayload,
        @Body() dto: StartOnboardingCheckoutDto,
    ) {
        return this.billing.startOnboardingCheckout(
            user.sub,
            dto.billingPlan,
            dto.billingInterval,
            dto.currency ?? 'INR',
        );
    }

    /** Polled by client after Razorpay modal closes — when status=ACTIVE, advance. */
    @Get('pending-status')
    getPendingStatus(@CurrentUser() user: JwtPayload) {
        return this.billing.getPendingStatus(user.sub);
    }
}
