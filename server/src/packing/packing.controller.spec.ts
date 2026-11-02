import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from '../auth/roles.guard';
import { OrgRequiredGuard } from '../auth/guards/org-required.guard';
import { VendorAccessGuard } from '../auth/guards/vendor-access.guard';
import { InfluencerAccessGuard } from '../auth/guards/influencer-access.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { SectionAccessGuard } from '../auth/guards/section-access.guard';
import { REQUIRE_SECTION_KEY } from '../auth/decorators/require-section.decorator';
import { PERMISSION_PRESETS } from '../auth/permissions';
import { OrderController } from '../order/order.controller';
import { PackingController } from './packing.controller';

/**
 * Who reaches the packing routes, through the app's own global guards in
 * their app.module order. The point: a Packer (an AGENT with inventory.pack
 * and no Orders section) reaches every packing route, and a vendor none.
 */

const reflector = new Reflector();
const guards = [
    new RolesGuard(reflector),
    new OrgRequiredGuard(reflector),
    new VendorAccessGuard(reflector),
    new InfluencerAccessGuard(reflector),
    new PermissionsGuard(reflector),
    new SectionAccessGuard(reflector),
];

type Handler = keyof PackingController;
const handlers = Object.getOwnPropertyNames(PackingController.prototype).filter((n) => n !== 'constructor') as Handler[];
const READS: Handler[] = ['queue', 'lookup', 'task'];

function reaches(user: Record<string, unknown>, handler: Handler): boolean {
    const ctx = {
        getHandler: () => PackingController.prototype[handler],
        getClass: () => PackingController,
        switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u1', orgId: 'org_1', ...user } }) }),
    } as unknown as ExecutionContext;
    try {
        return guards.every((g) => g.canActivate(ctx));
    } catch {
        return false;
    }
}

const reachable = (user: Record<string, unknown>) => handlers.filter((h) => reaches(user, h)).sort();
const all = [...handlers].sort();
const allButAccuracy = all.filter((h) => h !== 'accuracy');

describe('packing route access', () => {
    it('covers every route', () => {
        expect(all).toEqual(expect.arrayContaining(['queue', 'lookup', 'start', 'task', 'scan', 'confirm', 'count', 'undo', 'problem', 'clearProblem', 'hold', 'resume', 'finish', 'cancel', 'accuracy']));
    });

    it('is not tied to the Orders section', () => {
        expect(Reflect.getMetadata(REQUIRE_SECTION_KEY, PackingController)).toBeUndefined();
        for (const h of handlers) expect(Reflect.getMetadata(REQUIRE_SECTION_KEY, PackingController.prototype[h])).toBeUndefined();
    });

    it('lets a Packer, who has no Orders section, use every packing route', () => {
        const packer = PERMISSION_PRESETS.packer;
        expect(packer.grants).not.toContain('section.orders');
        expect(reachable({ role: packer.role, permissions: packer.grants })).toEqual(allButAccuracy);
    });

    it('lets owners, admins and managers use everything, accuracy included', () => {
        for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]) {
            expect(reachable({ role, permissions: [] })).toEqual(all);
        }
    });

    it('keeps vendors and influencers out of every route', () => {
        expect(reachable({ role: UserRole.VENDOR, vendorScope: 'Acme', permissions: ['inventory.pack', 'inventory.reports'] })).toEqual([]);
        expect(reachable({ role: UserRole.INFLUENCER, permissions: ['inventory.pack'] })).toEqual([]);
    });

    it('keeps out an agent with the Orders section but no inventory.pack', () => {
        expect(reachable({ role: UserRole.AGENT, permissions: ['section.orders'] })).toEqual([]);
    });

    it('opens accuracy on inventory.reports alone (the Accounts preset)', () => {
        const accounts = PERMISSION_PRESETS.accounts;
        expect(reachable({ role: accounts.role, permissions: accounts.grants })).toEqual(['accuracy']);
    });

    it('lets a viewer holding inventory.pack read but not pack', () => {
        expect(reachable({ role: UserRole.VIEWER, permissions: ['section.products', 'inventory.pack'] })).toEqual([...READS].sort());
    });
});

describe('order detail', () => {
    const order = { id: 'o1', name: '#1001' };
    const build = () => {
        const orderService = {
            findOne: jest.fn(() => Promise.resolve(order)),
            findOneForVendor: jest.fn(() => Promise.resolve(order)),
        };
        const packing = { orderPacking: jest.fn(() => Promise.resolve({ taskId: 't1', status: 'ON_HOLD' })) };
        return { controller: new OrderController(orderService as never, packing as never), packing };
    };

    it('carries the packing status', async () => {
        const { controller, packing } = build();
        await expect(controller.findOne('o1', { sub: 'u1', orgId: 'org_1', role: UserRole.AGENT } as never))
            .resolves.toEqual({ ...order, packing: { taskId: 't1', status: 'ON_HOLD' } });
        expect(packing.orderPacking).toHaveBeenCalledWith('org_1', 'o1');
    });

    it("leaves a vendor's view as it was", async () => {
        const { controller, packing } = build();
        await controller.findOne('o1', { sub: 'u1', orgId: 'org_1', role: UserRole.VENDOR, vendorScope: 'Acme' } as never);
        expect(packing.orderPacking).not.toHaveBeenCalled();
    });
});
