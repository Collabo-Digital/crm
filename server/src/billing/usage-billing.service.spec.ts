import { ConfigService } from '@nestjs/config';
import { Prisma, UsageBillStatus } from '@prisma/client';

import { RazorpayApiError } from '../payments/razorpay-merchant.client';
import { UsageBillingService } from './usage-billing.service';

describe('UsageBillingService', () => {
    const NOW = new Date('2026-11-01T01:00:00Z');
    const busy = { conversations: 6_234, callingMinutes: 1_100, members: 7, instagramAccounts: 1 };
    const config = new ConfigService({
        billing: { plans: { BASIC: { INR: 'plan_basicINR', USD: 'plan_basicUSD' }, GROWTH: { INR: 'plan_growthINR' } } },
    });
    const newBill = { id: 'bill_1', organizationId: 'org_1', period: '2026-10', attempts: 1, usage: null, createdAt: NOW };

    let prisma: {
        organization: { findMany: jest.Mock; findUniqueOrThrow: jest.Mock };
        usageBill: { create: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; findMany: jest.Mock };
    };
    let razorpay: Record<string, jest.Mock>;
    let usage: { usage: jest.Mock };
    let service: UsageBillingService;

    const subscription = (extra: Record<string, unknown>) =>
        razorpay.fetchSubscription.mockResolvedValue({ id: 'sub_1', status: 'active', plan_id: 'plan_basicINR', payment_method: 'card', ...extra });
    const finalUpdate = () => prisma.usageBill.update.mock.calls.at(-1)![0].data;

    beforeEach(() => {
        prisma = {
            organization: {
                findMany: jest.fn().mockResolvedValue([{ id: 'org_1' }]),
                findUniqueOrThrow: jest.fn().mockResolvedValue({
                    name: 'Acme',
                    externalSubscriptionId: 'sub_1',
                    members: [{ user: { email: 'owner@acme.test' } }],
                }),
            },
            usageBill: {
                create: jest.fn().mockResolvedValue(newBill),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                findUnique: jest.fn(),
                update: jest.fn().mockResolvedValue({}),
                findMany: jest.fn().mockResolvedValue([]),
            },
        };
        razorpay = {
            isConfigured: jest.fn().mockReturnValue(true),
            fetchSubscription: jest.fn(),
            addAddon: jest.fn().mockResolvedValue({ id: 'ao_1' }),
            addonsSince: jest.fn().mockResolvedValue([]),
            createPaymentLink: jest.fn().mockResolvedValue({ id: 'plink_1', short_url: 'https://rzp.io/i/usage', status: 'created' }),
            paymentLinkByReference: jest.fn().mockResolvedValue(null),
            paymentLink: jest.fn(),
        };
        usage = { usage: jest.fn().mockResolvedValue(busy) };
        service = new UsageBillingService(prisma as never, razorpay as never, usage as never, config);
    });

    it('bills last month to a card subscription as an add-on on its next invoice', async () => {
        subscription({});
        await service.tick(NOW);

        expect(usage.usage).toHaveBeenCalledWith('org_1', '2026-10');
        expect(razorpay.addAddon).toHaveBeenCalledWith('sub_1', {
            name: 'Collabo usage, October 2026',
            amount: 363_534,
            currency: 'INR',
            description: '1,234 conversations over the plan, 100 calling minutes over the plan, 2 extra team members, 1 Instagram account, GST 18%. Ref collabo-usage-bill_1',
        });
        expect(razorpay.addonsSince).not.toHaveBeenCalled();
        expect(finalUpdate()).toEqual({ status: UsageBillStatus.ADDED, externalId: 'ao_1', note: null });
        // The priced usage is saved before Razorpay is called.
        expect(prisma.usageBill.update.mock.calls[0][0].data).toMatchObject({ plan: 'BASIC', currency: 'INR', subtotal: 308_080, tax: 55_454, total: 363_534 });
    });

    it('emails a payment link when the subscription is paid by UPI', async () => {
        subscription({ payment_method: 'upi', customer_email: 'payer@acme.test', customer_contact: '+919800000000' });
        await service.tick(NOW);

        expect(razorpay.addAddon).not.toHaveBeenCalled();
        expect(razorpay.createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({
            amount: 363_534,
            currency: 'INR',
            reference_id: 'collabo-usage-bill_1',
            customer: { name: 'Acme', email: 'payer@acme.test', contact: '+919800000000' },
            notes: { organization_id: 'org_1', usage_bill_id: 'bill_1', period: '2026-10' },
        }));
        expect(finalUpdate()).toEqual({ status: UsageBillStatus.LINK_SENT, externalId: 'plink_1', paymentUrl: 'https://rzp.io/i/usage', note: null });
    });

    it('bills a dollar subscription in cents, without GST', async () => {
        subscription({ plan_id: 'plan_basicUSD' });
        await service.tick(NOW);
        expect(razorpay.addAddon).toHaveBeenCalledWith('sub_1', expect.objectContaining({ amount: 3_735, currency: 'USD' }));
    });

    it('never charges usage to a subscription on another plan, such as an earlier price', async () => {
        subscription({ plan_id: 'plan_SlznJFDuxEUtqi' });
        await service.tick(NOW);
        expect(usage.usage).not.toHaveBeenCalled();
        expect(razorpay.addAddon).not.toHaveBeenCalled();
        expect(finalUpdate()).toEqual({ status: UsageBillStatus.SKIPPED, note: 'The subscription is on a plan without usage prices.' });
    });

    it('skips a subscription Razorpay no longer has active', async () => {
        subscription({ status: 'halted' });
        await service.tick(NOW);
        expect(razorpay.addAddon).not.toHaveBeenCalled();
        expect(finalUpdate()).toEqual({ status: UsageBillStatus.SKIPPED, note: 'The subscription is halted.' });
    });

    it('charges nothing under ₹1', async () => {
        subscription({});
        usage.usage.mockResolvedValue({ conversations: 5_001, callingMinutes: 0, members: 1, instagramAccounts: 0 });
        await service.tick(NOW);
        expect(razorpay.addAddon).not.toHaveBeenCalled();
        expect(finalUpdate()).toMatchObject({ status: UsageBillStatus.NOTHING_DUE, total: 24 });
    });

    it('takes up a failed bill again without charging twice: an add-on the last try made is found', async () => {
        prisma.usageBill.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }));
        prisma.usageBill.updateMany.mockResolvedValue({ count: 1 });
        prisma.usageBill.findUnique.mockResolvedValue({ ...newBill, attempts: 2, usage: busy });
        razorpay.addonsSince.mockResolvedValue([
            { id: 'ao_other', subscription_id: 'sub_2', item: { description: 'Ref collabo-usage-bill_9' } },
            { id: 'ao_earlier', subscription_id: 'sub_1', item: { description: '… Ref collabo-usage-bill_1' } },
        ]);
        subscription({});
        await service.tick(NOW);

        expect(prisma.usageBill.updateMany.mock.calls[0][0].where).toMatchObject({ organizationId: 'org_1', period: '2026-10' });
        expect(usage.usage).not.toHaveBeenCalled();
        expect(razorpay.addAddon).not.toHaveBeenCalled();
        expect(finalUpdate()).toEqual({ status: UsageBillStatus.ADDED, externalId: 'ao_earlier', note: null });
    });

    it('records a Razorpay refusal as a failure, to be tried again', async () => {
        subscription({});
        razorpay.addAddon.mockRejectedValue(new RazorpayApiError(400, 'Add-ons can\'t be added for Subscriptions when payment mode is upi'));
        await service.tick(NOW);
        expect(finalUpdate()).toEqual({ status: UsageBillStatus.FAILED, note: 'Add-ons can\'t be added for Subscriptions when payment mode is upi' });
    });

    it('marks a payment link paid when Razorpay says so', async () => {
        prisma.organization.findMany.mockResolvedValue([]);
        prisma.usageBill.findMany.mockResolvedValue([{ externalId: 'plink_1' }]);
        razorpay.paymentLink.mockResolvedValue({ id: 'plink_1', status: 'paid' });
        await service.tick(NOW);
        expect(prisma.usageBill.updateMany).toHaveBeenCalledWith({
            where: { externalId: 'plink_1', status: UsageBillStatus.LINK_SENT },
            data: { status: UsageBillStatus.PAID },
        });
    });
});
