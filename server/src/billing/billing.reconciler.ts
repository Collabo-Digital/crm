import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RazorpayService } from './razorpay.service';

/**
 * Two crons that catch what webhooks miss:
 *
 *   1. Reconcile (every 10 min): if a webhook fails to arrive, fetch the
 *      authoritative subscription state from Razorpay's API.
 *   2. Cleanup (daily at 3 AM): cancel + clear Razorpay subscriptions that
 *      were created during onboarding but the user abandoned.
 *
 * Both age rows by User.updatedAt, so they write only when something changed.
 */
@Injectable()
export class BillingReconciler {
    private readonly logger = new Logger(BillingReconciler.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly razorpay: RazorpayService,
    ) { }

    @Cron(CronExpression.EVERY_10_MINUTES)
    async reconcilePendingSubscriptions() {
        if (!this.razorpay.isConfigured()) return;

        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);

        const stuckUsers = await this.prisma.user.findMany({
            where: {
                pendingExternalSubscriptionId: { not: null },
                pendingSubscriptionStatus: {
                    in: [SubscriptionStatus.CREATED, SubscriptionStatus.AUTHENTICATED],
                },
                updatedAt: { lt: twoMinAgo },
            },
            // Newest first: a missed webhook matters most to someone checking out now.
            orderBy: { updatedAt: 'desc' },
            take: 50,
        });

        for (const user of stuckUsers) {
            try {
                const sub = await this.razorpay.fetchSubscription(
                    user.pendingExternalSubscriptionId!,
                );
                if (await this.record(user, sub)) {
                    this.logger.log(`Reconciled user ${user.id} → ${sub.status}`);
                }
            } catch (err) {
                this.logger.error(
                    `Reconcile failed for user ${user.id}: ${(err as Error).message}`,
                );
            }
        }
    }

    @Cron('0 3 * * *')
    async cleanupAbandonedPending() {
        if (!this.razorpay.isConfigured()) return;

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const abandoned = await this.prisma.user.findMany({
            where: {
                pendingExternalSubscriptionId: { not: null },
                pendingSubscriptionStatus: {
                    in: [SubscriptionStatus.CREATED, SubscriptionStatus.AUTHENTICATED],
                },
                updatedAt: { lt: oneDayAgo },
            },
            select: { id: true, pendingExternalSubscriptionId: true, pendingSubscriptionStatus: true, pendingCurrentPeriodEnd: true },
        });

        for (const user of abandoned) {
            const subId = user.pendingExternalSubscriptionId!;
            try {
                const sub = await this.razorpay.fetchSubscription(subId);
                // Once the customer has authorised it, money may already be
                // moving: that one waits for its webhook or for a person.
                if (sub.status !== 'created') {
                    await this.record(user, sub);
                    continue;
                }
                await this.razorpay.cancelSubscription(subId);
            } catch (err) {
                // Kept: a subscription that may still be paid must stay findable by its webhook.
                this.logger.warn(
                    `Abandoned subscription ${subId} was not cancelled: ${(err as Error).message}`,
                );
                continue;
            }

            await this.prisma.user.updateMany({
                where: { id: user.id, pendingExternalSubscriptionId: subId },
                data: {
                    pendingBillingPlan: null,
                    pendingBillingInterval: null,
                    pendingBillingCurrency: null,
                    pendingExternalCustomerId: null,
                    pendingExternalSubscriptionId: null,
                    pendingSubscriptionStatus: null,
                    pendingCurrentPeriodEnd: null,
                },
            });
            this.logger.log(`Cleaned up abandoned pending for user ${user.id}`);
        }
    }

    /** Stores Razorpay's state of a pending subscription, if it changed; true when it wrote. */
    private async record(
        user: { id: string; pendingExternalSubscriptionId: string | null; pendingSubscriptionStatus: SubscriptionStatus | null; pendingCurrentPeriodEnd: Date | null },
        sub: { status: string; current_end: number | null },
    ): Promise<boolean> {
        const status = this.mapStatus(sub.status);
        const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;
        if (status === user.pendingSubscriptionStatus && periodEnd?.getTime() === user.pendingCurrentPeriodEnd?.getTime()) {
            return false;
        }
        // Conditional, so a webhook that landed meanwhile is not overwritten.
        const { count } = await this.prisma.user.updateMany({
            where: { id: user.id, pendingExternalSubscriptionId: user.pendingExternalSubscriptionId, pendingSubscriptionStatus: user.pendingSubscriptionStatus },
            data: { pendingSubscriptionStatus: status, pendingCurrentPeriodEnd: periodEnd },
        });
        return count > 0;
    }

    private mapStatus(raw: string): SubscriptionStatus {
        const map: Record<string, SubscriptionStatus> = {
            created: SubscriptionStatus.CREATED,
            authenticated: SubscriptionStatus.AUTHENTICATED,
            active: SubscriptionStatus.ACTIVE,
            paused: SubscriptionStatus.PAUSED,
            halted: SubscriptionStatus.HALTED,
            cancelled: SubscriptionStatus.CANCELLED,
            completed: SubscriptionStatus.COMPLETED,
            expired: SubscriptionStatus.EXPIRED,
        };
        return map[raw] ?? SubscriptionStatus.CREATED;
    }
}
