import { Injectable } from '@nestjs/common';
import { BillingPlan, BillingProvider, ChannelPlatform, ChannelStatus, StockLocationKind } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { BillingAccessService } from './billing-access';
import { BillingCurrency, periodOf, periodRange, pricingPlan, Usage, usageCharges } from './pricing';
import { BILLED_ROLES, seatOf } from './seats';

/** A channel that is connected and switched on. */
const LIVE_CHANNEL = { isEnabled: true, status: { not: ChannelStatus.DISCONNECTED } };

@Injectable()
export class UsageService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly billingAccess: BillingAccessService,
    ) { }

    /**
     * A month's usage. Calling minutes are each answered call's talk time,
     * rounded up to the minute. Seats, store locations, WhatsApp numbers and
     * Instagram accounts are counted as they are now: active Store locations
     * (where the till sells), and the organization's own Instagram accounts,
     * not influencers'.
     */
    async usage(organizationId: string, period: string): Promise<Usage> {
        const { start, end } = periodRange(period);
        const [month, calls, members, storeLocations, whatsappNumbers, instagramAccounts] = await Promise.all([
            this.prisma.usageMonth.findUnique({ where: { organizationId_period: { organizationId, period } }, select: { conversations: true } }),
            this.prisma.whatsAppCall.findMany({
                where: { organizationId, endedAt: { gte: start, lt: end }, durationSeconds: { gt: 0 } },
                select: { durationSeconds: true },
            }),
            this.prisma.organizationMember.findMany({
                where: { organizationId, isActive: true, role: { in: BILLED_ROLES } },
                select: { role: true, permissions: true },
            }),
            this.prisma.warehouse.count({ where: { organizationId, isActive: true, kind: StockLocationKind.STORE } }),
            this.prisma.channel.count({ where: { organizationId, platform: ChannelPlatform.WHATSAPP, ...LIVE_CHANNEL } }),
            this.prisma.channel.count({ where: { organizationId, platform: ChannelPlatform.INSTAGRAM, ownerUserId: null, ...LIVE_CHANNEL } }),
        ]);
        const opsSeats = members.filter((m) => seatOf(m.role, m.permissions) === 'ops').length;
        return {
            conversations: month?.conversations ?? 0,
            callingMinutes: calls.reduce((sum, c) => sum + Math.ceil(c.durationSeconds! / 60), 0),
            members: members.length - opsSeats,
            opsSeats,
            storeLocations,
            whatsappNumbers,
            instagramAccounts,
        };
    }

    /**
     * Settings → Billing: the plan (a trial's too) and where the workspace
     * stands, this month so far and what it would add, and past usage bills.
     */
    async summary(organizationId: string) {
        const org = await this.prisma.organization.findUniqueOrThrow({
            where: { id: organizationId },
            select: {
                billingPlan: true,
                billingInterval: true,
                billingCurrency: true,
                billingProvider: true,
                externalSubscriptionId: true,
                subscriptionStatus: true,
                currentPeriodEnd: true,
                trialEndsAt: true,
            },
        });
        const period = periodOf(new Date());
        const usage = await this.usage(organizationId, period);
        // A plan the Collabo team set up and invoices (Scale, Enterprise) has no Razorpay subscription.
        const manual = org.billingProvider === BillingProvider.MANUAL;
        const subscribed = manual || (!!org.externalSubscriptionId && !!org.subscriptionStatus);
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
            plan: org.billingPlan,
            access: this.billingAccess.of(org),
            subscription: subscribed
                ? {
                    plan: org.billingPlan,
                    interval: org.billingInterval,
                    manual,
                    // Null on a manual plan.
                    status: org.subscriptionStatus,
                    currency,
                    currentPeriodEnd: org.currentPeriodEnd,
                }
                : null,
            // What this month would add on the current plan. None without a
            // plan, nor on Enterprise, which is billed by contract. On a
            // manual plan the Collabo team invoices it.
            estimate: subscribed && org.billingPlan !== BillingPlan.ADVANCE
                ? usageCharges(pricingPlan(org.billingPlan), currency, usage)
                : null,
            bills,
        };
    }
}
