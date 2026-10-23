import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ORG_OPERATORS, Roles } from '../auth/decorators/roles.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { ConnectRazorpayDto } from './dto/payments.dto';
import { PaymentAccountsService } from './payment-accounts.service';
import { PaymentLinksService } from './payment-links.service';

/** Connecting the account that receives the money is for owners and admins. */
const ACCOUNT_OWNERS: UserRole[] = [UserRole.OWNER, UserRole.ADMIN];

/**
 * Settings → Orders → Payments (the organization's own Razorpay account) and the
 * payment links sent from it.
 */
@Controller('payments')
export class PaymentsController {
    constructor(
        private readonly accounts: PaymentAccountsService,
        private readonly links: PaymentLinksService,
    ) { }

    /** Everyone may see whether payments are on; the webhook address is for owners and admins. */
    @Get('razorpay')
    async account(@CurrentUser() user: SessionPayload) {
        const view = await this.accounts.view(user.orgId!);
        return ACCOUNT_OWNERS.includes(user.role!) ? view : { ...view, webhookToken: null };
    }

    @Post('razorpay/connect')
    @Roles(...ACCOUNT_OWNERS)
    connect(@CurrentUser() user: SessionPayload, @Body() dto: ConnectRazorpayDto) {
        return this.accounts.connect(user.orgId!, user.sub, dto);
    }

    @Post('razorpay/rotate-webhook-secret')
    @Roles(...ACCOUNT_OWNERS)
    rotate(@CurrentUser() user: SessionPayload) {
        return this.accounts.rotateWebhookSecret(user.orgId!);
    }

    @Delete('razorpay')
    @Roles(...ACCOUNT_OWNERS)
    @HttpCode(204)
    async disconnect(@CurrentUser() user: SessionPayload) {
        await this.accounts.disconnect(user.orgId!);
    }

    @Post('links/:id/refresh')
    @Roles(...ORG_OPERATORS)
    refresh(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.links.refresh(user.orgId!, id);
    }

    @Post('links/:id/cancel')
    @Roles(...ORG_OPERATORS)
    cancel(@CurrentUser() user: SessionPayload, @Param('id') id: string) {
        return this.links.cancel(user.orgId!, id);
    }
}
