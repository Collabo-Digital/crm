import { Injectable } from '@nestjs/common';
import { BillingPlan, ChannelPlatform, ChannelStatus, UserRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { BillingCurrency, periodOf, periodRange, pricingPlan, Usage, usageCharges } from './pricing';

/** Team members on the bill: people who work in Collabo. Viewers, vendors and influencers are free. */
const BILLED_ROLES: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.AGENT];

@Injectable()
export class UsageService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * A month's usage. Calling minutes are each answered call's talk time,
     * rounded up to the minute. Members and Instagram accounts are counted as
     * they are now: the organization's own Instagram accounts, not influencers'.
     */
    async usage(organizationId: string, period: string): Promise<Usage> {
        const { start, end } = periodRange(period);
        const [month, calls, members, instagramAccounts] = await Promise.all([
            this.prisma.usageMonth.findUnique({ where: { organizationId_period: { organizationId, period } }, select: { conversations: true } }),
            this.prisma.whatsAppCall.findMany({
                where: { organizationId, endedAt: { gte: start, lt: end }, durationSeconds: { gt: 0 } },
                select: { durationSeconds: true },
            }),
            this.prisma.organizationMember.count({ where: { organizationId, isActive: true, role: { in: BILLED_ROLES } } }),
            this.prisma.channel.count({
                where: { organizationId, platform: ChannelPlatform.INSTAGRAM, ownerUserId: null, isEnabled: true, status: { not: ChannelStatus.DISCONNECTED } },
            }),
        ]);
        return {
            conversations: month?.conversations ?? 0,
            callingMinutes: calls.reduce((sum, c) => sum + Math.ceil(c.durationSeconds! / 60), 0),
            members,
            instagramAccounts,
        };
    }

    /** Settings → Billing: the plan, this month so far and what it would add, and past usage bills. */
    async summary(organizationId: string) {
        const org = await this.prisma.organization.findUniqueOrThrow({
            where: { id: organizationId },
            select: {
                billingPlan: true,
                billingCurrency: true,
                externalSubscriptionId: true,
                subscriptionStatus: true,
                currentPeriodEnd: true,
            },
        });
        const period = periodOf(new Date());
        const usage = await this.usage(organizationId, period);
        const subscribed = !!org.externalSubscriptionId && !!org.subscriptionStatus;
        const currency = (org.billingCurrency ?? 'INR') as BillingCurrency;
        const bills = await this.prisma.usageBill.findMany({
            where: { organizationId },
            orderBy: { period: 'desc' },
            take: 12,
            select: { id: true, period: true, status: true, currency: true, usage: true, lines: true, subtotal: true, tax: true, total: true, paymentUrl: true, note: true, updatedAt: true },
        });
        return {
            period,
            usage,
            subscription: subscribed
                ? {
                    plan: org.billingPlan,
                    status: org.subscriptionStatus,
                    currency,
                    currentPeriodEnd: org.currentPeriodEnd,
                }
                : null,
            // What this month would add on the current plan. None without a
            // subscription, nor on Enterprise, which is billed by contract.
            estimate: subscribed && org.billingPlan !== BillingPlan.ADVANCE
                ? usageCharges(pricingPlan(org.billingPlan), currency, usage)
                : null,
            bills,
        };
    }
}
