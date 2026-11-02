import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { AdminController } from '../admin/admin.controller';
import { AuthController } from '../auth/auth.controller';
import { Public } from '../auth/decorators/public.decorator';
import { OrganizationController } from '../organization/organization.controller';
import { UserController } from '../user/user.controller';
import { RazorpayWebhookController } from './webhooks/razorpay-webhook.controller';
import { BillingAccessFields, billingAccess, BillingAccessService, billingRules, BillingRules, READ_ONLY_MESSAGE } from './billing-access';
import { BillingAccessGuard } from './billing-access.guard';
import { BillingController } from './billing.controller';
import { BillingUsageController } from './billing-usage.controller';

const DAY = 24 * 60 * 60 * 1000;
const FROM = new Date('2026-12-01T00:00:00Z');
const at = (days: number) => new Date(FROM.getTime() + days * DAY);
const ON: BillingRules = { enforced: true, from: FROM, trialDays: 14, graceDays: 7 };
const none: BillingAccessFields = { billingProvider: null, subscriptionStatus: null, trialEndsAt: null, currentPeriodEnd: null };

describe('billingAccess', () => {
    it('leaves every workspace active while enforcement is off', () => {
        expect(billingAccess(none, at(400), { enforced: false })).toEqual({ state: 'active', enforced: false, trialEndsAt: null, readOnlyFrom: null, daysLeft: null });
    });

    it('gives a workspace made before trials a trial from BILLING_ENFORCE_FROM, then a grace period, then read-only', () => {
        expect(billingAccess(none, at(0), ON)).toEqual({ state: 'trialing', enforced: true, trialEndsAt: at(14), readOnlyFrom: null, daysLeft: 14 });
        expect(billingAccess(none, at(9.5), ON)).toMatchObject({ state: 'trialing', daysLeft: 5 });
        expect(billingAccess(none, at(13.9), ON)).toMatchObject({ state: 'trialing', daysLeft: 1 });
        expect(billingAccess(none, at(14), ON)).toEqual({ state: 'grace', enforced: true, trialEndsAt: at(14), readOnlyFrom: at(21), daysLeft: 7 });
        expect(billingAccess(none, at(20.5), ON)).toMatchObject({ state: 'grace', daysLeft: 1 });
        expect(billingAccess(none, at(21), ON)).toEqual({ state: 'expired', enforced: true, trialEndsAt: at(14), readOnlyFrom: at(21), daysLeft: null });
    });

    it('uses the workspace\'s own trial end, as a new workspace or an extended trial has', () => {
        expect(billingAccess({ ...none, trialEndsAt: at(40) }, at(30), ON)).toMatchObject({ state: 'trialing', trialEndsAt: at(40), daysLeft: 10 });
        expect(billingAccess({ ...none, trialEndsAt: at(40) }, at(45), ON)).toMatchObject({ state: 'grace', readOnlyFrom: at(47) });
    });

    it('is active on a paid or authorised subscription, or a plan the Collabo team set up, whatever the dates', () => {
        for (const subscriptionStatus of ['ACTIVE', 'AUTHENTICATED'] as const) {
            expect(billingAccess({ ...none, billingProvider: 'RAZORPAY', subscriptionStatus }, at(400), ON)).toMatchObject({ state: 'active', enforced: true });
        }
        expect(billingAccess({ ...none, billingProvider: 'MANUAL' }, at(400), ON)).toMatchObject({ state: 'active' });
    });

    it('keeps a stopped subscription active to the end of the period paid for, then gives the grace period from there', () => {
        const halted: BillingAccessFields = { billingProvider: 'RAZORPAY', subscriptionStatus: 'HALTED', trialEndsAt: at(14), currentPeriodEnd: at(60) };
        expect(billingAccess(halted, at(59), ON)).toMatchObject({ state: 'active' });
        expect(billingAccess(halted, at(61), ON)).toMatchObject({ state: 'grace', readOnlyFrom: at(67), daysLeft: 6 });
        expect(billingAccess(halted, at(67), ON)).toMatchObject({ state: 'expired' });
        // A cancelled or unpaid one the same way.
        expect(billingAccess({ ...halted, subscriptionStatus: 'CANCELLED' }, at(62), ON)).toMatchObject({ state: 'grace' });
        expect(billingAccess({ ...halted, subscriptionStatus: 'CREATED', currentPeriodEnd: null }, at(30), ON)).toMatchObject({ state: 'expired' });
    });

    it('reads BILLING_ENFORCEMENT and its dates from the configuration', () => {
        expect(billingRules(new ConfigService({ billing: { enforcement: false } }))).toEqual({ enforced: false });
        expect(billingRules(new ConfigService({ billing: { enforcement: true, enforceFrom: '2026-12-01T00:00:00Z', trialDays: 30, graceDays: 3 } })))
            .toEqual({ enforced: true, from: FROM, trialDays: 30, graceDays: 3 });
    });
});

describe('BillingAccessService', () => {
    it('reads nothing while enforcement is off', async () => {
        const prisma = { organization: { findUnique: jest.fn() } };
        const service = new BillingAccessService(prisma as never, new ConfigService({ billing: { enforcement: false } }));
        await expect(service.isReadOnly('org_1')).resolves.toBe(false);
        expect(prisma.organization.findUnique).not.toHaveBeenCalled();
    });

    it('says a workspace past its trial and grace period is read-only', async () => {
        const prisma = { organization: { findUnique: jest.fn(() => Promise.resolve({ ...none, trialEndsAt: new Date(Date.now() - 30 * DAY) })) } };
        const config = new ConfigService({ billing: { enforcement: true, enforceFrom: FROM.toISOString(), trialDays: 14, graceDays: 7 } });
        await expect(new BillingAccessService(prisma as never, config).isReadOnly('org_1')).resolves.toBe(true);
    });
});

describe('BillingAccessGuard', () => {
    class Probe {
        write() { }
        @Public()
        hook() { }
    }

    function guard(readOnly: boolean | 'off') {
        const access = { enforced: readOnly !== 'off', isReadOnly: jest.fn(() => Promise.resolve(readOnly === true)) };
        return { access, guard: new BillingAccessGuard(new Reflector(), access as never) };
    }
    const context = (cls: object, handler: (...args: never[]) => unknown, method: string, user: object | null = { sub: 'u_1', orgId: 'org_1' }) =>
        ({
            getClass: () => cls,
            getHandler: () => handler,
            switchToHttp: () => ({ getRequest: () => ({ method, user: user ?? undefined }) }),
        }) as unknown as ExecutionContext;

    it('refuses a write in a read-only workspace with 402 and a plain message', async () => {
        const { guard: g, access } = guard(true);
        const refused = await g.canActivate(context(Probe, Probe.prototype.write, 'POST')).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(HttpException);
        expect((refused as HttpException).getStatus()).toBe(402);
        expect((refused as HttpException).getResponse()).toEqual({ message: READ_ONLY_MESSAGE, code: 'WORKSPACE_READ_ONLY' });
        expect(access.isReadOnly).toHaveBeenCalledWith('org_1');
        for (const method of ['PATCH', 'PUT', 'DELETE']) {
            await expect(g.canActivate(context(Probe, Probe.prototype.write, method))).rejects.toBeInstanceOf(HttpException);
        }
    });

    it('lets reads through, exports included', async () => {
        const { guard: g, access } = guard(true);
        for (const method of ['GET', 'HEAD', 'OPTIONS']) await expect(g.canActivate(context(Probe, Probe.prototype.write, method))).resolves.toBe(true);
        expect(access.isReadOnly).not.toHaveBeenCalled();
    });

    it('lets writes through in a workspace that is not read-only, and does nothing at all with enforcement off', async () => {
        await expect(guard(false).guard.canActivate(context(Probe, Probe.prototype.write, 'POST'))).resolves.toBe(true);
        const off = guard('off');
        await expect(off.guard.canActivate(context(Probe, Probe.prototype.write, 'POST'))).resolves.toBe(true);
        expect(off.access.isReadOnly).not.toHaveBeenCalled();
    });

    it('keeps inbound webhooks, public routes, the super-admin area, sign-in, the profile and billing working', async () => {
        const { guard: g, access } = guard(true);
        const open: Array<[object, (...args: never[]) => unknown]> = [
            [Probe, Probe.prototype.hook],
            [RazorpayWebhookController, RazorpayWebhookController.prototype.handleWebhook],
            [AdminController, AdminController.prototype.softDelete],
            [AdminController, AdminController.prototype.stop],
            [AuthController, AuthController.prototype.logout],
            [AuthController, AuthController.prototype.switchOrg],
            [UserController, UserController.prototype.updateProfile],
            [UserController, UserController.prototype.signOutOtherDevices],
            [BillingController, BillingController.prototype.startOnboardingCheckout],
            [BillingUsageController, BillingUsageController.prototype.subscribe],
            [OrganizationController, OrganizationController.prototype.create],
            [OrganizationController, OrganizationController.prototype.delete],
        ];
        for (const [cls, handler] of open) await expect(g.canActivate(context(cls, handler, 'POST'))).resolves.toBe(true);
        expect(access.isReadOnly).not.toHaveBeenCalled();
    });

    it('still refuses editing the workspace itself', async () => {
        const { guard: g } = guard(true);
        await expect(g.canActivate(context(OrganizationController, OrganizationController.prototype.update, 'PATCH'))).rejects.toBeInstanceOf(HttpException);
    });

    it('has nothing to check for a session without a workspace', async () => {
        const { guard: g, access } = guard(true);
        await expect(g.canActivate(context(Probe, Probe.prototype.write, 'POST', { sub: 'u_1' }))).resolves.toBe(true);
        await expect(g.canActivate(context(Probe, Probe.prototype.write, 'POST', null))).resolves.toBe(true);
        expect(access.isReadOnly).not.toHaveBeenCalled();
    });
});
