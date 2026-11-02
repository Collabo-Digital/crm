import { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';

import { BillingService } from './billing.service';

/** What a mocked Prisma call was handed. */
const dataOf = (fn: jest.Mock, call = 0) => (fn.mock.calls[call] as [{ data: Record<string, unknown> }])[0].data;

describe('BillingService.applyPendingSubscriptionToOrg', () => {
    const service = new BillingService({} as never, {} as never, new ConfigService({}), {} as never);
    const enforcing = new BillingService({} as never, {} as never, new ConfigService({ billing: { enforcement: true, enforceFrom: '2026-12-01T00:00:00Z', trialDays: 14, graceDays: 7 } }), {} as never);
    const tx = (pending: Record<string, unknown>, requested = 'BASIC') => ({
        user: { findUniqueOrThrow: jest.fn().mockResolvedValue(pending), update: jest.fn() },
        organization: { update: jest.fn(), findUniqueOrThrow: jest.fn().mockResolvedValue({ billingPlan: requested }) },
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

    it('leaves an organization made without a subscription on the plan asked for, with no trial, while enforcement is off', async () => {
        const t = tx({ pendingSubscriptionStatus: null }, 'GROWTH');
        await service.applyPendingSubscriptionToOrg(t as never, 'u_1', 'org_1');
        expect(t.organization.update).toHaveBeenCalledWith({ where: { id: 'org_1' }, data: { billingPlan: 'GROWTH', trialEndsAt: null } });
        expect(t.user.update).not.toHaveBeenCalled();
    });

    it('never lets the create request choose a plan the Collabo team sets up', async () => {
        for (const requested of ['SCALE', 'ADVANCE']) {
            const t = tx({ pendingSubscriptionStatus: null }, requested);
            await service.applyPendingSubscriptionToOrg(t as never, 'u_1', 'org_1');
            expect(t.organization.update).toHaveBeenCalledWith({ where: { id: 'org_1' }, data: { billingPlan: 'BASIC', trialEndsAt: null } });
        }
    });

    it('starts a 14-day trial of Growth for a workspace made without paying, while enforcement is on', async () => {
        const t = tx({ pendingSubscriptionStatus: null }, 'ADVANCE');
        const before = Date.now();
        await enforcing.applyPendingSubscriptionToOrg(t as never, 'u_1', 'org_1');
        const data = dataOf(t.organization.update);
        const trialMs = (data.trialEndsAt as Date).getTime() - before;
        expect(data.billingPlan).toBe('GROWTH');
        expect(trialMs).toBeGreaterThanOrEqual(14 * 24 * 3600_000);
        expect(trialMs).toBeLessThan(14 * 24 * 3600_000 + 60_000);
    });

    it('keeps a checkout left unpaid on the trial workspace, so paying it later counts there', async () => {
        const t = tx({
            pendingBillingPlan: 'PRO',
            pendingBillingInterval: 'YEARLY',
            pendingBillingCurrency: 'INR',
            pendingExternalCustomerId: null,
            pendingExternalSubscriptionId: 'sub_unpaid',
            pendingSubscriptionStatus: SubscriptionStatus.CREATED,
            pendingCurrentPeriodEnd: null,
        });
        await enforcing.applyPendingSubscriptionToOrg(t as never, 'u_1', 'org_1');
        const data = dataOf(t.organization.update);
        expect(data).toMatchObject({
            billingPlan: 'GROWTH',
            externalSubscriptionId: 'sub_unpaid',
            subscriptionStatus: 'CREATED',
            billingProvider: 'RAZORPAY',
        });
        expect(data.billingInterval).toBeUndefined();
        expect(dataOf(t.user.update)).toMatchObject({ pendingExternalSubscriptionId: null, pendingSubscriptionStatus: null });
    });

    it('says where a workspace stands, and whether trials and the payment step are on', () => {
        expect(enforcing.plans()).toMatchObject({ enforcement: true, trialDays: 14 });
        expect(service.plans()).toMatchObject({ enforcement: false, trialDays: null });
        expect(enforcing.access({ billingProvider: 'MANUAL', subscriptionStatus: null, trialEndsAt: null, currentPeriodEnd: null, paymentFailedAt: null })).toMatchObject({ state: 'active', enforced: true });
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

describe('BillingService checkout', () => {
    const config = new ConfigService({
        billing: {
            plans: {
                BASIC: { MONTHLY: { INR: 'plan_basicINR', USD: 'plan_basicUSD' }, YEARLY: { INR: 'plan_basicINRyearly' } },
                PRO: { MONTHLY: { INR: 'plan_proINR' } },
            },
            salesEmail: 'sales@collabo.test',
        },
    });
    function build() {
        const prisma = {
            user: { findUniqueOrThrow: jest.fn(() => Promise.resolve({ id: 'u_1', email: 'owner@acme.test' })), update: jest.fn(() => Promise.resolve({})) },
        };
        const razorpay = { createSubscription: jest.fn(() => Promise.resolve({ id: 'sub_new' })), getKeyId: jest.fn(() => 'rzp_test_1') };
        return { prisma, razorpay, service: new BillingService(prisma as never, razorpay as never, config, {} as never) };
    }

    it('lists, for each self-serve plan, the currencies it can be bought in monthly and yearly', () => {
        const { service } = build();
        const catalog = service.plans();
        expect(catalog.checkout).toEqual({
            BASIC: { MONTHLY: ['INR', 'USD'], YEARLY: ['INR'] },
            GROWTH: { MONTHLY: [], YEARLY: [] },
            PRO: { MONTHLY: ['INR'], YEARLY: [] },
        });
        expect(catalog).toMatchObject({ gstPercent: 18, yearlyDiscountPercent: 20, salesEmail: 'sales@collabo.test' });
        expect(catalog.plans.map((p) => p.id)).toEqual(['BASIC', 'GROWTH', 'PRO', 'SCALE', 'ADVANCE']);
    });

    it('starts a yearly subscription on the yearly Razorpay plan, for ten years of renewals', async () => {
        const { service, prisma, razorpay } = build();
        await expect(service.startOnboardingCheckout('u_1', 'BASIC', 'YEARLY', 'INR')).resolves.toEqual({ subscriptionId: 'sub_new', razorpayKeyId: 'rzp_test_1', currency: 'INR' });
        expect(razorpay.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ planId: 'plan_basicINRyearly', totalCount: 10 }));
        expect(dataOf(prisma.user.update)).toMatchObject({ pendingBillingPlan: 'BASIC', pendingBillingInterval: 'YEARLY' });
        await service.startOnboardingCheckout('u_1', 'BASIC', 'MONTHLY', 'USD');
        expect(razorpay.createSubscription).toHaveBeenLastCalledWith(expect.objectContaining({ planId: 'plan_basicUSD', totalCount: 120 }));
    });

    it('refuses a plan, interval or currency without a Razorpay plan, and the plans sold by the Collabo team', async () => {
        const { service, razorpay } = build();
        await expect(service.startOnboardingCheckout('u_1', 'BASIC', 'YEARLY', 'USD')).rejects.toThrow('The Starter plan cannot be bought yearly in USD yet.');
        await expect(service.startOnboardingCheckout('u_1', 'GROWTH', 'MONTHLY', 'INR')).rejects.toThrow('The Growth plan cannot be bought monthly in INR yet.');
        await expect(service.startOnboardingCheckout('u_1', 'SCALE', 'YEARLY', 'INR')).rejects.toThrow('Scale is set up with the Collabo team. Book a demo to start it.');
        await expect(service.startOnboardingCheckout('u_1', 'ADVANCE', 'MONTHLY', 'INR')).rejects.toThrow('Enterprise is set up with the Collabo team. Talk to us to start it.');
        expect(razorpay.createSubscription).not.toHaveBeenCalled();
    });
});

describe('BillingService.subscribeOrganization', () => {
    const config = new ConfigService({ billing: { plans: { GROWTH: { MONTHLY: { INR: 'plan_growthINR' }, YEARLY: { INR: 'plan_growthINRyearly' } } } } });
    function build(org: Record<string, unknown>, remote: Record<string, unknown> = { status: 'halted', current_end: null, plan_id: 'plan_growthINR' }, taken = 1) {
        const prisma = {
            organization: {
                findUniqueOrThrow: jest.fn(() => Promise.resolve(org)),
                updateMany: jest.fn().mockResolvedValueOnce({ count: taken }).mockResolvedValue({ count: 1 }),
            },
            user: { findUniqueOrThrow: jest.fn(() => Promise.resolve({ email: 'owner@acme.test' })), updateMany: jest.fn(() => Promise.resolve({ count: 0 })) },
        };
        const razorpay = {
            fetchSubscription: jest.fn(() => Promise.resolve({ id: org.externalSubscriptionId, ...remote })),
            createSubscription: jest.fn(() => Promise.resolve({ id: 'sub_new' })),
            cancelSubscription: jest.fn(() => Promise.resolve()),
            getKeyId: jest.fn(() => 'rzp_test_1'),
        };
        return { prisma, razorpay, service: new BillingService(prisma as never, razorpay as never, config, {} as never) };
    }

    it('starts a subscription for the workspace, leaving its plan as it is until Razorpay says it is paid', async () => {
        const { service, prisma, razorpay } = build({ billingProvider: null, externalSubscriptionId: null, subscriptionStatus: null });
        await expect(service.subscribeOrganization('org_1', 'u_1', 'GROWTH', 'YEARLY', 'INR')).resolves.toEqual({ subscriptionId: 'sub_new', razorpayKeyId: 'rzp_test_1', currency: 'INR' });
        expect(razorpay.createSubscription).toHaveBeenCalledWith({
            planId: 'plan_growthINRyearly',
            totalCount: 10,
            notifyEmail: 'owner@acme.test',
            notes: { organizationId: 'org_1', userId: 'u_1', plan: 'GROWTH', interval: 'YEARLY', currency: 'INR' },
        });
        expect(prisma.organization.updateMany).toHaveBeenCalledWith({
            where: { id: 'org_1', externalSubscriptionId: null },
            data: { externalSubscriptionId: 'sub_new', subscriptionStatus: 'CREATED', billingProvider: 'RAZORPAY' },
        });
        expect(razorpay.fetchSubscription).not.toHaveBeenCalled();
        expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
    });

    it('asks Razorpay about the subscription it replaces, and cancels it when it was left unpaid or halted', async () => {
        const { service, razorpay } = build({ billingProvider: 'RAZORPAY', externalSubscriptionId: 'sub_halted', subscriptionStatus: 'HALTED' });
        await service.subscribeOrganization('org_1', 'u_1', 'GROWTH', 'MONTHLY', 'INR');
        expect(razorpay.fetchSubscription).toHaveBeenCalledWith('sub_halted');
        expect(razorpay.cancelSubscription).toHaveBeenCalledWith('sub_halted');
    });

    it('never replaces a subscription Razorpay has been paid for, though no webhook said so: it records it instead', async () => {
        const { service, prisma, razorpay } = build(
            { billingProvider: 'RAZORPAY', externalSubscriptionId: 'sub_paid', subscriptionStatus: 'CREATED' },
            { status: 'active', current_end: 1_800_000_000, plan_id: 'plan_growthINR' },
        );
        await expect(service.subscribeOrganization('org_1', 'u_1', 'GROWTH', 'MONTHLY', 'INR')).rejects.toThrow('already pays for a plan');
        expect(razorpay.createSubscription).not.toHaveBeenCalled();
        expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
        expect(dataOf(prisma.organization.updateMany)).toMatchObject({ subscriptionStatus: 'ACTIVE', billingPlan: 'GROWTH', billingInterval: 'MONTHLY', paymentFailedAt: null });
    });

    it('gives up when another checkout took the workspace meanwhile, cancelling its own', async () => {
        const { service, razorpay } = build({ billingProvider: null, externalSubscriptionId: null, subscriptionStatus: null }, undefined, 0);
        await expect(service.subscribeOrganization('org_1', 'u_1', 'GROWTH', 'MONTHLY', 'INR')).rejects.toThrow('Another payment was started');
        expect(razorpay.cancelSubscription).toHaveBeenCalledWith('sub_new');
    });

    it('refuses a workspace already paying, and one on a plan the Collabo team set up', async () => {
        for (const org of [
            { billingProvider: 'RAZORPAY', externalSubscriptionId: 'sub_live', subscriptionStatus: 'ACTIVE' },
            { billingProvider: 'MANUAL', externalSubscriptionId: null, subscriptionStatus: null },
        ]) {
            const { service, razorpay } = build(org);
            await expect(service.subscribeOrganization('org_1', 'u_1', 'GROWTH', 'MONTHLY', 'INR')).rejects.toThrow(/Talk to/);
            expect(razorpay.createSubscription).not.toHaveBeenCalled();
        }
    });
});

describe('BillingService.handleWebhookEvent', () => {
    const config = new ConfigService({ billing: { plans: { PRO: { YEARLY: { USD: 'plan_proUSDyearly' } } } } });

    it('moves a workspace to the plan its subscription is on once Razorpay activates it', async () => {
        const prisma = {
            user: { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) },
            organization: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
        };
        const service = new BillingService(prisma as never, {} as never, config, {} as never);
        await service.handleWebhookEvent('subscription.activated', {
            subscription: { entity: { id: 'sub_1', status: 'active', current_end: 1_800_000_000, customer_id: 'cust_1', plan_id: 'plan_proUSDyearly' } },
        });
        expect(prisma.organization.updateMany).toHaveBeenCalledWith({
            where: { externalSubscriptionId: 'sub_1' },
            data: {
                subscriptionStatus: 'ACTIVE',
                currentPeriodEnd: new Date(1_800_000_000_000),
                externalCustomerId: 'cust_1',
                billingPlan: 'PRO',
                billingInterval: 'YEARLY',
                billingCurrency: 'USD',
                paymentFailedAt: null,
            },
        });

        await service.handleWebhookEvent('subscription.charged', {
            subscription: { entity: { id: 'sub_2', status: 'active', current_end: null, plan_id: 'plan_earlierPrice' } },
        });
        expect(prisma.organization.updateMany).toHaveBeenLastCalledWith({ where: { externalSubscriptionId: 'sub_2' }, data: { subscriptionStatus: 'ACTIVE', currentPeriodEnd: null, paymentFailedAt: null } });
    });

    it('notes when a payment first failed, a retry under way (pending) as much as a halt', async () => {
        const prisma = {
            user: { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) },
            organization: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
        };
        const service = new BillingService(prisma as never, {} as never, config, {} as never);
        await service.handleWebhookEvent('subscription.pending', { subscription: { entity: { id: 'sub_1', status: 'pending', current_end: null } } });
        expect(prisma.organization.updateMany).toHaveBeenCalledTimes(2);
        expect(prisma.organization.updateMany).toHaveBeenNthCalledWith(1, { where: { externalSubscriptionId: 'sub_1' }, data: { subscriptionStatus: 'HALTED', currentPeriodEnd: null } });
        expect(prisma.organization.updateMany).toHaveBeenNthCalledWith(2, { where: { externalSubscriptionId: 'sub_1', paymentFailedAt: null }, data: { paymentFailedAt: expect.any(Date) as Date } });
    });

    it('learns the plan of a subscription paid by invoice from Razorpay', async () => {
        const prisma = {
            user: { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) },
            organization: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
        };
        const razorpay = { isConfigured: () => true, fetchSubscription: jest.fn(() => Promise.resolve({ id: 'sub_1', status: 'active', plan_id: 'plan_proUSDyearly' })) };
        const service = new BillingService(prisma as never, razorpay as never, config, {} as never);
        await service.handleWebhookEvent('invoice.paid', { invoice: { entity: { id: 'inv_1', subscription_id: 'sub_1', status: 'paid' } } });
        expect(dataOf(prisma.organization.updateMany)).toMatchObject({ subscriptionStatus: 'ACTIVE', billingPlan: 'PRO', billingInterval: 'YEARLY', billingCurrency: 'USD' });
    });
});
