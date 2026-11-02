import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { IS_SUPER_ADMIN_KEY } from '../auth/decorators/super-admin.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { ALLOW_WHEN_EXPIRED_KEY } from './allow-when-expired.decorator';
import { BillingAccessService, READ_ONLY_MESSAGE } from './billing-access';

/** Methods that only read. Exports are reads, so they keep working. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Read-only for a workspace whose trial and grace period ended without a paid
 * plan: every write in it is refused with 402. Not refused: @Public routes
 * (inbound webhooks from Meta, Shopify and Razorpay, public pages and the
 * public API), the super-admin area, and routes marked @AllowWhenExpired.
 * Registered after the session guards, so the member's workspace is known.
 * With BILLING_ENFORCEMENT off it reads nothing.
 */
@Injectable()
export class BillingAccessGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly access: BillingAccessService,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (!this.access.enforced) return true;
        const req = context.switchToHttp().getRequest<{ method: string; user?: JwtPayload }>();
        if (READS.has(req.method)) return true;
        const exempt = [IS_PUBLIC_KEY, IS_SUPER_ADMIN_KEY, ALLOW_WHEN_EXPIRED_KEY].some((key) =>
            this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]),
        );
        if (exempt || !req.user?.orgId) return true;
        if (!(await this.access.isReadOnly(req.user.orgId))) return true;
        throw new HttpException({ message: READ_ONLY_MESSAGE, code: 'WORKSPACE_READ_ONLY' }, HttpStatus.PAYMENT_REQUIRED);
    }
}
