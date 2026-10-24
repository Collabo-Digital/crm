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
            take: 50,
        });

        for (const user of stuckUsers) {
            try {
                const sub = await this.razorpay.fetchSubscription(
                    user.pendingExternalSubscriptionId!,
                );
                await this.prisma.user.update({
                    where: { id: user.id },
                    data: {
                        pendingSubscriptionStatus: this.mapStatus(sub.status),
                        pendingCurrentPeriodEnd: sub.current_end
                            ? new Date(sub.current_end * 1000)
                            : null,
                    },
                });
                this.logger.log(`Reconciled user ${user.id} → ${sub.status}`);
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
            select: { id: true, pendingExternalSubscriptionId: true },
        });

        for (const user of abandoned) {
            try {
                await this.razorpay.cancelSubscription(
                    user.pendingExternalSubscriptionId!,
                );
            } catch (err) {
                // It might already be cancelled / expired on Razorpay side.
                this.logger.warn(
                    `Cancel on Razorpay failed for ${user.pendingExternalSubscriptionId}: ${(err as Error).message}`,
                );
            }

            await this.prisma.user.update({
                where: { id: user.id },
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
