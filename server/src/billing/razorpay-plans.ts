import { ConfigService } from '@nestjs/config';
import { BillingInterval, BillingPlan } from '@prisma/client';

import { BILLING_CURRENCIES, BILLING_INTERVALS, BillingCurrency, PLANS } from './pricing';

/**
 * The Razorpay plan for each self-serve plan, interval and currency, from the
 * environment (RAZORPAY_PLAN_BASIC_INR for monthly, RAZORPAY_PLAN_BASIC_INR_YEARLY
 * for yearly, and so on): test and live mode have their own ids. A plan
 * without one cannot be bought that way. Scale and Enterprise have none: the
 * Collabo team invoices them.
 *
 * Server-side only: never trust a plan id sent from the client.
 */
export function razorpayPlanId(config: ConfigService, plan: BillingPlan, interval: BillingInterval, currency: BillingCurrency): string | null {
    return config.get<string>(`billing.plans.${plan}.${interval}.${currency}`) || null;
}

/** Which plan, interval and currency a subscription's Razorpay plan is; null for any other plan, such as an earlier price. */
export function planOfRazorpayId(
    config: ConfigService,
    planId: string,
): { plan: BillingPlan; interval: BillingInterval; currency: BillingCurrency } | null {
    for (const p of PLANS) {
        for (const interval of BILLING_INTERVALS) {
            for (const currency of BILLING_CURRENCIES) {
                if (razorpayPlanId(config, p.id, interval, currency) === planId) return { plan: p.id, interval, currency };
            }
        }
    }
    return null;
}
