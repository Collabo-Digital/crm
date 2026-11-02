import { BillingInterval, BillingPlan } from '@prisma/client';
import { IsBoolean, IsEnum, IsISO8601, IsOptional } from 'class-validator';

/** Body for `PATCH /admin/organizations/:orgId/billing`. Every field is optional; what is sent is changed. */
export class SetOrganizationBillingDto {
    @IsOptional() @IsEnum(BillingPlan) billingPlan?: BillingPlan;

    @IsOptional() @IsEnum(BillingInterval) billingInterval?: BillingInterval;

    /** True: the Collabo team invoices this workspace (billing provider MANUAL). False: it no longer does. */
    @IsOptional() @IsBoolean() manual?: boolean;

    /** When the trial ends: later to extend it, null to end it now. */
    @IsOptional() @IsISO8601() trialEndsAt?: string | null;
}
