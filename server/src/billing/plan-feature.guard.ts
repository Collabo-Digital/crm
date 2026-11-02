import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { BillingAccessService } from './billing-access';
import { GATE_PLAN, PlanGate, pricingPlan } from './pricing';
import { PLAN_FEATURE_KEY } from './require-plan-feature.decorator';

/**
 * Routes marked @RequirePlanFeature answer 403 for a workspace whose plan
 * lacks the feature, saying which plan has it. Nothing is refused while
 * BILLING_ENFORCEMENT is off, so nobody loses a feature before plans are sold.
 */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly access: BillingAccessService,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const gate = this.reflector.getAllAndOverride<PlanGate | undefined>(PLAN_FEATURE_KEY, [context.getHandler(), context.getClass()]);
        if (!gate || !this.access.enforced) return true;
        const orgId = context.switchToHttp().getRequest<{ user?: JwtPayload }>().user?.orgId;
        if (!orgId || (await this.access.allows(orgId, gate))) return true;
        const plan = pricingPlan(GATE_PLAN[gate]).name;
        throw new ForbiddenException({ message: `Available on ${plan}. Book a demo to upgrade.`, code: 'PLAN_FEATURE_LOCKED', feature: gate, plan: GATE_PLAN[gate] });
    }
}
