import { Body, Controller, Get, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { AllowWhenExpired } from './allow-when-expired.decorator';
import { BillingService } from './billing.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { UsageService } from './usage.service';

/**
 * Settings → Billing: the organization's plan, usage and usage bills, which
 * owners and admins see. Only the owner changes what the workspace pays.
 */
@Controller('billing')
@AllowWhenExpired()
export class BillingUsageController {
    constructor(
        private readonly usage: UsageService,
        private readonly billing: BillingService,
    ) { }

    @Get('usage')
    @Roles(UserRole.OWNER, UserRole.ADMIN)
    summary(@CurrentUser() user: SessionPayload) {
        return this.usage.summary(user.orgId!);
    }

    @Post('subscribe')
    @Roles(UserRole.OWNER)
    subscribe(@CurrentUser() user: SessionPayload, @Body() dto: SubscribeDto) {
        return this.billing.subscribeOrganization(user.orgId!, user.sub, dto.billingPlan, dto.billingInterval, dto.currency ?? 'INR');
    }
}
