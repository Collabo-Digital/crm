import { SetMetadata } from '@nestjs/common';

import type { PlanGate } from './pricing';

export const PLAN_FEATURE_KEY = 'planFeature';

/**
 * The route needs a feature not every plan has (planFeatures). Refused by
 * PlanFeatureGuard only while BILLING_ENFORCEMENT is on.
 */
export const RequirePlanFeature = (gate: PlanGate) => SetMetadata(PLAN_FEATURE_KEY, gate);
