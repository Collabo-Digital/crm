import { ConfigService } from '@nestjs/config';
import { BillingPlan } from '@prisma/client';

import { BILLING_CURRENCIES, BillingCurrency, PLANS } from './pricing';

/**
 * The Razorpay plan for each self-serve plan and currency, from the
 * environment (RAZORPAY_PLAN_BASIC_INR and so on): test and live mode have
 * their own ids. A plan without one cannot be bought in that currency.
 *
 * Server-side only: never trust a plan id sent from the client.
 */
export function razorpayPlanId(config: ConfigService, plan: BillingPlan, currency: BillingCurrency): string | null {
    return config.get<string>(`billing.plans.${plan}.${currency}`) || null;
}

/** Which plan and currency a subscription's Razorpay plan is; null for any other plan, such as an earlier price. */
export function planOfRazorpayId(config: ConfigService, planId: string): { plan: BillingPlan; currency: BillingCurrency } | null {
    for (const p of PLANS) {
        for (const currency of BILLING_CURRENCIES) {
            if (razorpayPlanId(config, p.id, currency) === planId) return { plan: p.id, currency };
        }
    }
    return null;
}
