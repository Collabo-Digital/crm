import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StockBucket, UserRole } from '@prisma/client';
import { RolesGuard } from '../auth/roles.guard';
import { VendorAccessGuard } from '../auth/guards/vendor-access.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { SectionAccessGuard } from '../auth/guards/section-access.guard';
import { PERMISSION_PRESETS } from '../auth/permissions';
import { assertMayAdjust } from './goods-receipt';
import { InventoryController } from './inventory.controller';

/**
 * Goods in for a member who may receive stock but not adjust it: units
 * arriving, booked with reason "received", and nothing that corrects, removes
 * or writes off a count.
 */

const RECEIVER = { role: UserRole.AGENT, permissions: ['section.products', 'inventory.view', 'inventory.receive'] };
const ADJUSTER = { role: UserRole.AGENT, permissions: ['section.products', 'inventory.view', 'inventory.adjust'] };
const line = (over: Partial<{ bucket: StockBucket; delta: number; setTo: number }> = {}) => ({ bucket: StockBucket.AVAILABLE, delta: 5, ...over });

describe('assertMayAdjust', () => {
    it('lets a receiver book units received, into Available, QC or Damaged', () => {
        expect(() => assertMayAdjust(RECEIVER, 'received', [line(), line({ bucket: StockBucket.QC }), line({ bucket: StockBucket.DAMAGED, delta: 1 })])).not.toThrow();
    });

    it.each([
        ['a set-to', 'received', [{ bucket: StockBucket.AVAILABLE, setTo: 10 }]],
        ['a removal', 'received', [line({ delta: -2 })]],
        ['another reason', 'correction', [line()]],
        ['no reason', undefined, [line()]],
        ['units into Reserved', 'received', [line({ bucket: StockBucket.RESERVED })]],
        ['one bad line in a batch', 'received', [line(), line({ delta: -1 })]],
    ])('refuses a receiver %s', (_case, reason, lines) => {
        expect(() => assertMayAdjust(RECEIVER, reason, lines)).toThrow(ForbiddenException);
    });

    it('does not narrow a member who may adjust, or a manager', () => {
        expect(() => assertMayAdjust(ADJUSTER, 'correction', [{ bucket: StockBucket.AVAILABLE, setTo: 0 }])).not.toThrow();
        expect(() => assertMayAdjust({ role: UserRole.MANAGER, permissions: [] }, 'damage', [line({ delta: -3 })])).not.toThrow();
    });
});

describe('stock adjustment routes', () => {
    const reflector = new Reflector();
    const guards = [new RolesGuard(reflector), new VendorAccessGuard(reflector), new PermissionsGuard(reflector), new SectionAccessGuard(reflector)];
    const proto = InventoryController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const reaches = (handler: string, user: Record<string, unknown>) => {
        const ctx = {
            getHandler: () => proto[handler],
            getClass: () => InventoryController,
            switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u1', orgId: 'org_1', ...user } }) }),
        } as unknown as ExecutionContext;
        try {
            return guards.every((g) => g.canActivate(ctx));
        } catch {
            return false;
        }
    };

    it.each(['createAdjustment', 'createAdjustmentsBulk'])('%s opens to a receiver, an adjuster and the Warehouse job', (handler) => {
        const warehouse = PERMISSION_PRESETS.find((p) => p.id === 'warehouse')!;
        expect(reaches(handler, RECEIVER)).toBe(true);
        expect(reaches(handler, ADJUSTER)).toBe(true);
        expect(reaches(handler, { role: UserRole.AGENT, permissions: warehouse.grants })).toBe(true);
    });

    it.each(['createAdjustment', 'createAdjustmentsBulk'])('%s stays closed without either key, and to viewers', (handler) => {
        expect(reaches(handler, { role: UserRole.AGENT, permissions: ['section.products', 'inventory.view', 'inventory.pack'] })).toBe(false);
        expect(reaches(handler, { role: UserRole.VIEWER, permissions: ['section.products', 'inventory.receive'] })).toBe(false);
    });

    it('books a receiver\'s goods in, and refuses their correction before it reaches the service', async () => {
        const inventory = {
            createAdjustment: jest.fn(() => Promise.resolve({ id: 'mv_1' })),
            createAdjustmentsBulk: jest.fn(() => Promise.resolve({ applied: 1 })),
        };
        const controller = new InventoryController(inventory as never, {} as never);
        const user = { sub: 'u1', email: 'r@test.local', orgId: 'org_1', emailVerified: true, memberships: [], ...RECEIVER };

        await controller.createAdjustment('org_1', user, { variantId: 'v1', warehouseId: 'w1', bucket: StockBucket.AVAILABLE, delta: 4, reason: 'received' });
        expect(inventory.createAdjustment).toHaveBeenCalledTimes(1);

        expect(() =>
            controller.createAdjustmentsBulk('org_1', user, { warehouseId: 'w1', reason: 'correction', items: [{ variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 3 }] }),
        ).toThrow(ForbiddenException);
        expect(inventory.createAdjustmentsBulk).not.toHaveBeenCalled();
    });
});
