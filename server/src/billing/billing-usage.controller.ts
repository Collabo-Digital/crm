import { Controller, Get } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { SessionPayload } from '../auth/interfaces/jwt-payload.interface';
import { UsageService } from './usage.service';

/** Settings → Billing: the organization's plan, usage and usage bills. */
@Controller('billing/usage')
export class BillingUsageController {
    constructor(private readonly usage: UsageService) { }

    @Get()
    @Roles(UserRole.OWNER, UserRole.ADMIN)
    summary(@CurrentUser() user: SessionPayload) {
        return this.usage.summary(user.orgId!);
    }
}
