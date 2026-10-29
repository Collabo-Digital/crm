import { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';

import { BillingService } from './billing.service';

describe('BillingService.applyPendingSubscriptionToOrg', () => {
    const service = new BillingService({} as never, {} as never, new ConfigService({}), {} as never);
    const tx = (pending: Record<string, unknown>) => ({
        user: { findUniqueOrThrow: jest.fn().mockResolvedValue(pending), update: jest.fn() },
        organization: { update: jest.fn() },
    });

    it('gives the new organization the plan, interval and currency that were paid for', async () => {
        const t = tx({
            pendingBillingPlan: 'BASIC',
            pendingBillingInterval: 'MONTHLY',
            pendingBillingCurrency: 'USD',
            pendingExternalCustomerId: 'cust_1',
            pendingExternalSubscriptionId: 'sub_1',
            pendingSubscriptionStatus: SubscriptionStatus.ACTIVE,
            pendingCurrentPeriodEnd: null,
        });
        await service.applyPendingSubscriptionToOrg(t as never, 'u_1', 'org_1');
        expect(t.organization.update).toHaveBeenCalledWith({
            where: { id: 'org_1' },
            data: expect.objectContaining({ billingPlan: 'BASIC', billingInterval: 'MONTHLY', billingCurrency: 'USD', externalSubscriptionId: 'sub_1', subscriptionStatus: 'ACTIVE' }),
        });
        expect(t.user.update.mock.calls[0][0].data).toMatchObject({ pendingBillingPlan: null, pendingBillingCurrency: null, pendingExternalSubscriptionId: null });
    });

    it('leaves an organization made without a subscription as it is, while the payment step is off', async () => {
        const t = tx({ pendingSubscriptionStatus: null });
        await service.applyPendingSubscriptionToOrg(t as never, 'u_1', 'org_1');
        expect(t.organization.update).not.toHaveBeenCalled();
    });
});

describe('BillingService.cancelOrganizationSubscription', () => {
    function build(org: Record<string, unknown> | null, remoteStatus = 'active') {
        const prisma = {
            organization: { findUnique: jest.fn().mockResolvedValue(org), update: jest.fn().mockResolvedValue(undefined) },
        };
        const razorpay = {
            isConfigured: jest.fn().mockReturnValue(true),
            fetchSubscription: jest.fn().mockResolvedValue({ id: 'sub_1', status: remoteStatus }),
            cancelSubscription: jest.fn().mockResolvedValue(undefined),
        };
        const service = new BillingService(prisma as never, razorpay as never, new ConfigService({}), {} as never);
        return { service, prisma, razorpay };
    }

    it('cancels a live subscription and records it', async () => {
        const { service, prisma, razorpay } = build({ externalSubscriptionId: 'sub_1', subscriptionStatus: SubscriptionStatus.ACTIVE });
        await service.cancelOrganizationSubscription('org_1');
        expect(razorpay.cancelSubscription).toHaveBeenCalledWith('sub_1');
        expect(prisma.organization.update).toHaveBeenCalledWith({ where: { id: 'org_1' }, data: { subscriptionStatus: 'CANCELLED' } });
    });

    it('does nothing for a workspace with no subscription or one already ended', async () => {
        for (const org of [{ externalSubscriptionId: null, subscriptionStatus: null }, { externalSubscriptionId: 'sub_1', subscriptionStatus: SubscriptionStatus.CANCELLED }]) {
            const { service, razorpay } = build(org);
            await service.cancelOrganizationSubscription('org_1');
            expect(razorpay.fetchSubscription).not.toHaveBeenCalled();
        }
    });

    it('does not cancel again what Razorpay already ended', async () => {
        const { service, prisma, razorpay } = build({ externalSubscriptionId: 'sub_1', subscriptionStatus: SubscriptionStatus.ACTIVE }, 'cancelled');
        await service.cancelOrganizationSubscription('org_1');
        expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
        expect(prisma.organization.update).toHaveBeenCalled();
    });

    it('stops the deletion when Razorpay cannot be reached', async () => {
        const { service, prisma, razorpay } = build({ externalSubscriptionId: 'sub_1', subscriptionStatus: SubscriptionStatus.ACTIVE });
        razorpay.fetchSubscription.mockRejectedValue(new Error('timeout'));
        await expect(service.cancelOrganizationSubscription('org_1')).rejects.toThrow('could not be cancelled');
        expect(prisma.organization.update).not.toHaveBeenCalled();
    });
});
