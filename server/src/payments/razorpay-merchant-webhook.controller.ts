import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PaymentLinksService } from './payment-links.service';

/**
 * POST /webhooks/razorpay/merchant/:token — set up by the merchant in their
 * own Razorpay dashboard. The token picks the account and that account's
 * webhook secret must sign the raw body. Not to be confused with
 * POST /webhooks/razorpay, Collabo's own subscription billing.
 */
@SkipThrottle()
@Controller('webhooks/razorpay/merchant')
export class RazorpayMerchantWebhookController {
    constructor(private readonly links: PaymentLinksService) { }

    @Public()
    @Post(':token')
    @HttpCode(200)
    receive(@Param('token') token: string, @Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature?: string) {
        return this.links.webhook(token, req.rawBody, signature);
    }
}
