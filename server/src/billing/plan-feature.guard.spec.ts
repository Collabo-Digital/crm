import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { BillingPlan } from '@prisma/client';

import { MessagingAnalyticsController } from '../analytics/messaging/messaging-analytics.controller';
import { DeveloperController } from '../developer/developer.controller';
import { PackingController } from '../packing/packing.controller';
import { BillingAccessService } from './billing-access';
import { PlanFeatureGuard } from './plan-feature.guard';
import { RequirePlanFeature } from './require-plan-feature.decorator';

class Probe {
    @RequirePlanFeature('storeScoping')
    limitStores() { }

    open() { }
}

const ENFORCING = { billing: { enforcement: true, enforceFrom: '2026-11-01T00:00:00Z', trialDays: 14, graceDays: 7 } };

function build(plan: BillingPlan | null, enforced = true) {
    const prisma = { organization: { findUnique: jest.fn(() => Promise.resolve(plan ? { billingPlan: plan } : null)) } };
    const access = new BillingAccessService(prisma as never, new ConfigService(enforced ? ENFORCING : {}));
    return { prisma, guard: new PlanFeatureGuard(new Reflector(), access) };
}
const context = (cls: { prototype: object }, handler: string) =>
    ({
        getClass: () => cls,
        getHandler: (): unknown => Reflect.get(cls.prototype, handler),
        switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u_1', orgId: 'org_1' } }) }),
    }) as unknown as ExecutionContext;
const refusal = (guard: PlanFeatureGuard, cls: { prototype: object }, handler: string) =>
    guard.canActivate(context(cls, handler)).then(() => null, (e: unknown) => e);

describe('PlanFeatureGuard', () => {
    it('keeps the packing assistant, messaging analytics and making API keys and webhooks to Growth and above', async () => {
        const { guard } = build(BillingPlan.BASIC);
        for (const [cls, handler] of [
            [PackingController, 'queue'],
            [MessagingAnalyticsController, 'overview'],
            [DeveloperController, 'createKey'],
            [DeveloperController, 'createWebhook'],
        ] as const) {
            const err = await refusal(guard, cls, handler);
            expect(err).toBeInstanceOf(ForbiddenException);
            expect((err as ForbiddenException).getResponse()).toMatchObject({ message: 'Available on Growth. Book a demo to upgrade.', code: 'PLAN_FEATURE_LOCKED', plan: 'GROWTH' });
        }
        // Keys already made can still be listed and revoked.
        await expect(guard.canActivate(context(DeveloperController, 'listKeys'))).resolves.toBe(true);
        await expect(guard.canActivate(context(DeveloperController, 'revokeKey'))).resolves.toBe(true);
        const growth = build(BillingPlan.GROWTH).guard;
        await expect(growth.canActivate(context(PackingController, 'queue'))).resolves.toBe(true);
        await expect(growth.canActivate(context(DeveloperController, 'createKey'))).resolves.toBe(true);
    });

    it('keeps store-limited staff to Unlimited and above', async () => {
        const err = await refusal(build(BillingPlan.GROWTH).guard, Probe, 'limitStores');
        expect((err as ForbiddenException).getResponse()).toMatchObject({ message: 'Available on Unlimited. Book a demo to upgrade.', feature: 'storeScoping', plan: 'SCALE' });
        await expect(build(BillingPlan.SCALE).guard.canActivate(context(Probe, 'limitStores'))).resolves.toBe(true);
        await expect(build(BillingPlan.ADVANCE).guard.canActivate(context(Probe, 'limitStores'))).resolves.toBe(true);
    });

    it('opens every feature, and reads nothing, while enforcement is off', async () => {
        const { guard, prisma } = build(BillingPlan.BASIC, false);
        await expect(guard.canActivate(context(PackingController, 'queue'))).resolves.toBe(true);
        await expect(guard.canActivate(context(Probe, 'limitStores'))).resolves.toBe(true);
        expect(prisma.organization.findUnique).not.toHaveBeenCalled();
    });

    it('leaves routes without a plan feature alone', async () => {
        const { guard, prisma } = build(BillingPlan.BASIC);
        await expect(guard.canActivate(context(Probe, 'open'))).resolves.toBe(true);
        expect(prisma.organization.findUnique).not.toHaveBeenCalled();
    });
});
