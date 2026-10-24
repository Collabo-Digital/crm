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
