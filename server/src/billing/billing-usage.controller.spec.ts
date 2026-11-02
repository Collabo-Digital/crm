import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { RolesGuard } from '../auth/roles.guard';
import { BillingUsageController } from './billing-usage.controller';

describe('BillingUsageController roles', () => {
    const guard = new RolesGuard(new Reflector());
    const allowed = (handler: unknown, role: UserRole) =>
        guard.canActivate({
            getHandler: () => handler,
            getClass: () => BillingUsageController,
            switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u_1', orgId: 'org_1', role } }) }),
        } as unknown as ExecutionContext);
    const summary: unknown = Reflect.get(BillingUsageController.prototype, 'summary');
    const subscribe: unknown = Reflect.get(BillingUsageController.prototype, 'subscribe');

    it('lets owners and admins see billing, and nobody else', () => {
        expect([UserRole.OWNER, UserRole.ADMIN].map((r) => allowed(summary, r))).toEqual([true, true]);
        expect([UserRole.MANAGER, UserRole.AGENT, UserRole.VIEWER].map((r) => allowed(summary, r))).toEqual([false, false, false]);
    });

    it('lets only the owner subscribe the workspace to a plan', () => {
        expect(allowed(subscribe, UserRole.OWNER)).toBe(true);
        expect([UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT].map((r) => allowed(subscribe, r))).toEqual([false, false, false]);
    });
});
