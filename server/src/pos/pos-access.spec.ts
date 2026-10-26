import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ALLOW_VENDOR_KEY } from '../auth/decorators/allow-vendor.decorator';
import { REQUIRE_SECTION_KEY } from '../auth/decorators/require-section.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { VendorAccessGuard } from '../auth/guards/vendor-access.guard';
import { SectionAccessGuard } from '../auth/guards/section-access.guard';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { PosController } from './pos.controller';
import { PosPublicController } from './pos-public.controller';

/**
 * Who may use the till, read off the real decorators and run through the
 * real guards: anyone who handles orders may sell, only managers change the
 * settings and the staff, and viewers and vendors get nothing at all.
 */

const proto = PosController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const handlers = Object.getOwnPropertyNames(PosController.prototype)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined)
    .map((name) => [name, proto[name]] as const);

function contextFor(handler: (...a: unknown[]) => unknown, user: Record<string, unknown>): ExecutionContext {
    return {
        getHandler: () => handler,
        getClass: () => PosController,
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
}

const reflector = new Reflector();
const passes = (handler: (...a: unknown[]) => unknown, user: Record<string, unknown>) => {
    try {
        return (
            new RolesGuard(reflector).canActivate(contextFor(handler, user)) &&
            new VendorAccessGuard(reflector).canActivate(contextFor(handler, user)) &&
            new SectionAccessGuard(reflector).canActivate(contextFor(handler, user))
        );
    } catch (err) {
        if (err instanceof ForbiddenException) return false;
        throw err;
    }
};

const MANAGER_ONLY = ['updateSettings', 'listStaff', 'createStaff', 'updateStaff'];

describe('point-of-sale access', () => {
    it('has the routes of the contract', () => {
        expect(handlers.map(([name]) => name).sort()).toEqual(
            ['setup', 'updateSettings', 'listStaff', 'createStaff', 'updateStaff', 'unlock', 'approve', 'products', 'scan', 'customers', 'createSale', 'collectPayment', 'delivery', 'sendBill', 'receipt'].sort(),
        );
    });

    it('belongs to the Orders section', () => {
        expect(Reflect.getMetadata(REQUIRE_SECTION_KEY, PosController)).toEqual(['section.orders']);
    });

    it.each(handlers)('%s declares a role group, never opens to vendors', (_name, fn) => {
        const roles: UserRole[] = Reflect.getMetadata(ROLES_KEY, fn);
        expect(roles?.length).toBeGreaterThan(0);
        expect(roles).not.toContain(UserRole.VIEWER);
        expect(roles).not.toContain(UserRole.VENDOR);
        expect(Reflect.getMetadata(ALLOW_VENDOR_KEY, fn)).toBeUndefined();
    });

    it.each(handlers)('%s refuses a viewer and a vendor', (_name, fn) => {
        expect(passes(fn, { role: UserRole.VIEWER, permissions: [] })).toBe(false);
        expect(passes(fn, { role: UserRole.VENDOR, vendorScope: 'Acme' })).toBe(false);
        expect(passes(fn, { role: UserRole.INFLUENCER, permissions: [] })).toBe(false);
    });

    it.each(handlers)('%s lets a manager in', (_name, fn) => {
        expect(passes(fn, { role: UserRole.MANAGER, permissions: [] })).toBe(true);
    });

    it.each(handlers.filter(([name]) => !MANAGER_ONLY.includes(name)))('%s lets an agent with the Orders section sell', (_name, fn) => {
        expect(passes(fn, { role: UserRole.AGENT, permissions: ['section.orders'] })).toBe(true);
    });

    it.each(handlers.filter(([name]) => MANAGER_ONLY.includes(name)))('%s is for managers only', (_name, fn) => {
        expect(passes(fn, { role: UserRole.AGENT, permissions: ['section.orders'] })).toBe(false);
    });

    it.each(handlers)('%s refuses an agent without the Orders section', (_name, fn) => {
        expect(passes(fn, { role: UserRole.AGENT, permissions: ['section.chat'] })).toBe(false);
    });

    it('the public bill needs no login and no section, and is not throttle-exempt', () => {
        const bill = PosPublicController.prototype.bill;
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, bill)).toBe(true);
        expect(Reflect.getMetadata(REQUIRE_SECTION_KEY, PosPublicController)).toBeUndefined();
        expect(Reflect.getMetadataKeys(bill).concat(Reflect.getMetadataKeys(PosPublicController)).some((k) => String(k).includes('SKIP'))).toBe(false);
    });

    it('prints a receipt for an agent who has Orders but not Invoices', () => {
        expect(passes(proto.receipt, { role: UserRole.AGENT, permissions: ['section.orders'] })).toBe(true);
    });
});
