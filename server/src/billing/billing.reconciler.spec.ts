import { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';
import { BillingReconciler } from './billing.reconciler';

const config = new ConfigService({ billing: { plans: { GROWTH: { YEARLY: { INR: 'plan_growthINRyearly' } } } } });

const pendingUser = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    pendingExternalSubscriptionId: 'sub_1',
    pendingSubscriptionStatus: SubscriptionStatus.CREATED,
    pendingCurrentPeriodEnd: null,
    ...over,
});

function build(users: ReturnType<typeof pendingUser>[], sub: { status: string; current_end: number | null } | Error) {
    const prisma = { user: { findMany: jest.fn().mockResolvedValue(users), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() } };
    const razorpay = {
        isConfigured: () => true,
        fetchSubscription: sub instanceof Error ? jest.fn().mockRejectedValue(sub) : jest.fn().mockResolvedValue({ id: 'sub_1', ...sub }),
        cancelSubscription: jest.fn(),
    };
    return { prisma, razorpay, reconciler: new BillingReconciler(prisma as any, razorpay as any, config) };
}

describe('BillingReconciler', () => {
    describe('reconcile', () => {
        it('does not write when Razorpay reports what is stored, so the row can age into the cleanup', async () => {
            const t = build([pendingUser()], { status: 'created', current_end: null });
            await t.reconciler.reconcilePendingSubscriptions();
            expect(t.prisma.user.updateMany).not.toHaveBeenCalled();
            expect(t.prisma.user.update).not.toHaveBeenCalled();
        });

        it('stores a change it finds', async () => {
            const t = build([pendingUser()], { status: 'active', current_end: 1_790_000_000 });
            await t.reconciler.reconcilePendingSubscriptions();
            expect(t.prisma.user.updateMany).toHaveBeenCalledWith({
                where: { id: 'u1', pendingExternalSubscriptionId: 'sub_1', pendingSubscriptionStatus: SubscriptionStatus.CREATED },
                data: { pendingSubscriptionStatus: SubscriptionStatus.ACTIVE, pendingCurrentPeriodEnd: new Date(1_790_000_000_000) },
            });
        });
    });

    describe('reconcile, for checkouts from Settings', () => {
        function org(sub: { status: string; current_end: number | null; plan_id: string } | Error) {
            const prisma = {
                organization: {
                    findMany: jest.fn(() => Promise.resolve([{ id: 'org_1', externalSubscriptionId: 'sub_9', subscriptionStatus: SubscriptionStatus.CREATED }])),
                    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
                },
            };
            const razorpay = {
                isConfigured: () => true,
                fetchSubscription: sub instanceof Error ? jest.fn(() => Promise.reject(sub)) : jest.fn(() => Promise.resolve({ id: 'sub_9', ...sub })),
            };
            return { prisma, razorpay, reconciler: new BillingReconciler(prisma as never, razorpay as never, config) };
        }

        it('records a payment whose webhook went missing, and moves the workspace to the plan paid for', async () => {
            const t = org({ status: 'active', current_end: 1_800_000_000, plan_id: 'plan_growthINRyearly' });
            await t.reconciler.reconcileOrganizationSubscriptions();
            expect(t.prisma.organization.updateMany).toHaveBeenCalledWith({
                where: { id: 'org_1', externalSubscriptionId: 'sub_9', subscriptionStatus: SubscriptionStatus.CREATED },
                data: { subscriptionStatus: SubscriptionStatus.ACTIVE, currentPeriodEnd: new Date(1_800_000_000_000), billingPlan: 'GROWTH', billingInterval: 'YEARLY', billingCurrency: 'INR' },
            });
        });

        it('writes nothing for a checkout still unpaid, or when Razorpay cannot be reached', async () => {
            for (const sub of [{ status: 'created', current_end: null, plan_id: 'plan_growthINRyearly' }, new Error('timeout')]) {
                const t = org(sub);
                await t.reconciler.reconcileOrganizationSubscriptions();
                expect(t.prisma.organization.updateMany).not.toHaveBeenCalled();
            }
        });
    });

    describe('cleanup of abandoned checkouts', () => {
        it('cancels a subscription nobody authorised and clears the pending checkout', async () => {
            const t = build([pendingUser()], { status: 'created', current_end: null });
            await t.reconciler.cleanupAbandonedPending();
            expect(t.razorpay.cancelSubscription).toHaveBeenCalledWith('sub_1');
            expect(t.prisma.user.updateMany).toHaveBeenCalledWith({
                where: { id: 'u1', pendingExternalSubscriptionId: 'sub_1' },
                data: expect.objectContaining({ pendingExternalSubscriptionId: null, pendingSubscriptionStatus: null }),
            });
        });

        it('leaves a subscription the customer has authorised, recording its state', async () => {
            const t = build([pendingUser({ pendingSubscriptionStatus: SubscriptionStatus.AUTHENTICATED })], { status: 'active', current_end: null });
            await t.reconciler.cleanupAbandonedPending();
            expect(t.razorpay.cancelSubscription).not.toHaveBeenCalled();
            expect(t.prisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { pendingSubscriptionStatus: SubscriptionStatus.ACTIVE, pendingCurrentPeriodEnd: null } }));
        });

        it('keeps the pending checkout when Razorpay cannot be reached, so a late payment still finds its user', async () => {
            const t = build([pendingUser()], new Error('timeout'));
            await t.reconciler.cleanupAbandonedPending();
            expect(t.razorpay.cancelSubscription).not.toHaveBeenCalled();
            expect(t.prisma.user.updateMany).not.toHaveBeenCalled();
        });

        it('keeps the pending checkout when the cancel fails', async () => {
            const t = build([pendingUser()], { status: 'created', current_end: null });
            t.razorpay.cancelSubscription.mockRejectedValue(new Error('Razorpay 500'));
            await t.reconciler.cleanupAbandonedPending();
            expect(t.prisma.user.updateMany).not.toHaveBeenCalled();
        });
    });
});
