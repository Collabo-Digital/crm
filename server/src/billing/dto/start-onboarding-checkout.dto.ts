import { BillingInterval, BillingPlan } from '@prisma/client';
import { IsEnum, IsIn, IsOptional } from 'class-validator';

import { BILLING_CURRENCIES } from '../pricing';
import type { BillingCurrency } from '../pricing';

export class StartOnboardingCheckoutDto {
    @IsEnum(BillingPlan)
    billingPlan: BillingPlan;

    @IsEnum(BillingInterval)
    billingInterval: BillingInterval;

    /** The currency the plan is paid in. Rupees unless chosen. */
    @IsOptional()
    @IsIn(BILLING_CURRENCIES)
    currency?: BillingCurrency;
}
