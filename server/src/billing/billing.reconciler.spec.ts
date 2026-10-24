import { SubscriptionStatus } from '@prisma/client';
import { BillingReconciler } from './billing.reconciler';

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
    return { prisma, razorpay, reconciler: new BillingReconciler(prisma as any, razorpay as any) };
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
