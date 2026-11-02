import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

describe('AdminService.setOrganizationBilling', () => {
    const trialOrg = {
        id: 'org_1', billingPlan: 'GROWTH', billingInterval: null, billingProvider: null, externalSubscriptionId: null, subscriptionStatus: null,
        trialEndsAt: new Date('2026-12-15T00:00:00Z'), currentPeriodEnd: null, paymentFailedAt: null,
    };
    const enforcing = new ConfigService({ billing: { enforcement: true, enforceFrom: '2026-12-01T00:00:00Z', trialDays: 14, graceDays: 7 } });
    function build(org: Record<string, unknown> | null, config = new ConfigService({})) {
        const prisma = {
            organization: {
                findFirst: jest.fn(() => Promise.resolve(org)),
                update: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...org, ...data })),
            },
        };
        const service = new AdminService(prisma as never, {} as never, config);
        const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
        return { service, prisma, log };
    }

    it('puts a workspace on a plan the Collabo team invoices, and logs who did it and what it was', async () => {
        const { service, prisma, log } = build(trialOrg);
        const updated = await service.setOrganizationBilling('org_1', { billingPlan: 'SCALE', billingInterval: 'YEARLY', manual: true }, 'u_admin');

        expect(prisma.organization.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'org_1', deletedAt: null } }));
        expect(prisma.organization.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'org_1' },
            data: { billingPlan: 'SCALE', billingInterval: 'YEARLY', billingProvider: 'MANUAL' },
        }));
        expect(updated).toMatchObject({ billingPlan: 'SCALE', billingProvider: 'MANUAL' });
        expect(log).toHaveBeenCalledWith('Billing of org org_1 set by super admin u_admin: billingPlan "GROWTH" → "SCALE", billingInterval null → "YEARLY", billingProvider null → "MANUAL"');
    });

    it('extends a trial, or ends it now (a null stored would mean the trial counted from BILLING_ENFORCE_FROM), and takes a workspace off a manual plan', async () => {
        const { service, prisma } = build({ ...trialOrg, billingProvider: 'MANUAL' });
        await service.setOrganizationBilling('org_1', { trialEndsAt: '2027-01-15T00:00:00.000Z' }, 'u_admin');
        expect(prisma.organization.update.mock.calls[0][0].data).toEqual({ trialEndsAt: new Date('2027-01-15T00:00:00Z') });
        const before = Date.now();
        await service.setOrganizationBilling('org_1', { trialEndsAt: null, manual: false }, 'u_admin');
        const ended = prisma.organization.update.mock.calls[1][0].data as { billingProvider: unknown; trialEndsAt: Date };
        expect(ended.billingProvider).toBeNull();
        expect(ended.trialEndsAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('never puts a workspace on a manual plan while a Razorpay subscription that could still charge it is attached', async () => {
        for (const subscriptionStatus of ['HALTED', 'CREATED', 'PAUSED']) {
            const { service, prisma } = build({ ...trialOrg, billingProvider: 'RAZORPAY', externalSubscriptionId: 'sub_7', subscriptionStatus });
            await expect(service.setOrganizationBilling('org_1', { billingPlan: 'SCALE', manual: true }, 'u_admin')).rejects.toThrow('still has Razorpay subscription sub_7');
            expect(prisma.organization.update).not.toHaveBeenCalled();
        }
        const { service } = build({ ...trialOrg, billingProvider: 'RAZORPAY', externalSubscriptionId: 'sub_7', subscriptionStatus: 'CANCELLED' });
        await expect(service.setOrganizationBilling('org_1', { billingPlan: 'SCALE', manual: true }, 'u_admin')).resolves.toMatchObject({ billingProvider: 'MANUAL' });
    });

    it('shows a workspace made before trials its real trial end, counted from BILLING_ENFORCE_FROM', async () => {
        const { service } = build({ ...trialOrg, trialEndsAt: null }, enforcing);
        await expect(service.setOrganizationBilling('org_1', { billingInterval: 'MONTHLY' }, 'u_admin')).resolves.toMatchObject({ trialEndsAt: new Date('2026-12-15T00:00:00Z') });
    });

    it('leaves the plan of a workspace paying through Razorpay to its subscription, but still extends its trial', async () => {
        const { service, prisma } = build({ ...trialOrg, billingProvider: 'RAZORPAY', subscriptionStatus: 'ACTIVE' });
        await expect(service.setOrganizationBilling('org_1', { billingPlan: 'SCALE' }, 'u_admin')).rejects.toThrow('pays through a Razorpay subscription');
        await expect(service.setOrganizationBilling('org_1', { manual: true }, 'u_admin')).rejects.toThrow('pays through a Razorpay subscription');
        expect(prisma.organization.update).not.toHaveBeenCalled();
        await service.setOrganizationBilling('org_1', { trialEndsAt: '2027-01-15T00:00:00.000Z' }, 'u_admin');
        expect(prisma.organization.update).toHaveBeenCalledTimes(1);
    });

    it('finds no deleted or unknown workspace', async () => {
        const { service } = build(null);
        await expect(service.setOrganizationBilling('org_x', { billingPlan: 'GROWTH' }, 'u_admin')).rejects.toThrow('Organization not found');
    });
});

describe('AdminController set plan', () => {
    it('is for super admins only', () => {
        const guard = new SuperAdminGuard(new Reflector());
        const as = (user: object) => ({
            getHandler: (): unknown => Reflect.get(AdminController.prototype, 'setOrganizationBilling'),
            getClass: () => AdminController,
            switchToHttp: () => ({ getRequest: () => ({ user }) }),
        }) as unknown as ExecutionContext;
        expect(guard.canActivate(as({ sub: 'u_admin', isSuperAdmin: true }))).toBe(true);
        expect(() => guard.canActivate(as({ sub: 'u_owner', role: 'OWNER' }))).toThrow(ForbiddenException);
        // An impersonation session is no super admin here.
        expect(() => guard.canActivate(as({ sub: 'u_owner', impersonatedBy: 'u_admin' }))).toThrow(ForbiddenException);
    });
});
