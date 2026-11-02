import { ExecutionContext, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { RolesGuard } from '../auth/roles.guard';
import { OrgRequiredGuard } from '../auth/guards/org-required.guard';
import { VendorAccessGuard } from '../auth/guards/vendor-access.guard';
import { InfluencerAccessGuard } from '../auth/guards/influencer-access.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { SectionAccessGuard } from '../auth/guards/section-access.guard';
import { ALLOW_VENDOR_KEY } from '../auth/decorators/allow-vendor.decorator';
import { REQUIRE_PERMISSIONS_KEY } from '../auth/decorators/require-permissions.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSION_PRESETS } from '../auth/permissions';
import { ProductController } from './product.controller';

/**
 * Who changes the catalogue, through the app's global guards in their
 * app.module order. The Products section reads; every write (create, edit,
 * prices, the stock counts in the product form, variants, photos, delete,
 * bulk actions, CSV import, pushing to Shopify) also needs products.edit.
 * Owners, admins and managers hold it implicitly; vendors edit their own
 * products as before, confined by their vendor scope.
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

type Route = { name: string; handler: (...a: unknown[]) => unknown; read: boolean };

const proto = ProductController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const routes: Route[] = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined)
    .map((name) => ({
        name,
        handler: proto[name],
        read: Reflect.getMetadata(METHOD_METADATA, proto[name]) === RequestMethod.GET,
    }));
const reads = routes.filter((r) => r.read);
const writes = routes.filter((r) => !r.read);

/** Which locations stock a variant: a stock change, behind inventory.adjust like any adjustment. */
const STOCK_ROUTES = ['setVariantLocations'];
const managerOnly = (r: Route) => !(Reflect.getMetadata(ROLES_KEY, r.handler) as UserRole[]).includes(UserRole.AGENT);

function reaches(user: Record<string, unknown>, route: Route): boolean {
    const ctx = {
        getHandler: () => route.handler,
        getClass: () => ProductController,
        switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u1', orgId: 'org_1', ...user } }) }),
    } as unknown as ExecutionContext;
    try {
        return guards.every((g) => g.canActivate(ctx));
    } catch {
        return false;
    }
}

const names = (list: Route[]) => list.map((r) => r.name).sort();
const reachable = (user: Record<string, unknown>) => names(routes.filter((r) => reaches(user, r)));
const template = (id: string) => PERMISSION_PRESETS.find((p) => p.id === id)!.grants;

describe('product route access', () => {
    it('has the reads and writes to check', () => {
        expect(names(reads)).toEqual(['exportCsv', 'findAll', 'findOne', 'getImportJob', 'getProductTypes', 'getStats', 'getVendors']);
        expect(writes.length).toBeGreaterThanOrEqual(26);
    });

    it.each(writes.filter((r) => !STOCK_ROUTES.includes(r.name)).map((r) => [r.name, r] as const))(
        '%s asks for products.edit',
        (_name, route) => {
            expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, route.handler)).toEqual(['products.edit']);
        },
    );

    it('keeps the stock-location route on inventory.adjust', () => {
        expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, proto.setVariantLocations)).toEqual(['inventory.adjust']);
    });

    it('lets an agent with the Products section read everything and change nothing', () => {
        expect(reachable({ role: UserRole.AGENT, permissions: ['section.products'] })).toEqual(names(reads));
        expect(reachable({ role: UserRole.AGENT, permissions: ['section.products', 'inventory.view', 'inventory.adjust'] })).toEqual(
            names([...reads, ...writes.filter((r) => STOCK_ROUTES.includes(r.name))]),
        );
    });

    it('lets an agent holding products.edit make every change an agent may', () => {
        const editor = writes.filter((r) => !managerOnly(r) && !STOCK_ROUTES.includes(r.name));
        expect(editor.map((r) => r.name)).toEqual(expect.arrayContaining(['create', 'update', 'updateVariant', 'bulkUpdateVariants', 'deleteVariant', 'bulkSetStatus']));
        expect(reachable({ role: UserRole.AGENT, permissions: ['section.products', 'products.edit'] })).toEqual(names([...reads, ...editor]));
    });

    it('treats an agent with no section (full access) by the key alone', () => {
        expect(reachable({ role: UserRole.AGENT, permissions: [] })).toEqual(names(reads));
        expect(reachable({ role: UserRole.AGENT, permissions: ['products.edit'] })).toEqual(
            names([...reads, ...writes.filter((r) => !managerOnly(r) && !STOCK_ROUTES.includes(r.name))]),
        );
    });

    it('lets owners, admins and managers do everything, without any grant', () => {
        for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]) {
            expect(reachable({ role, permissions: [] })).toEqual(names(routes));
        }
    });

    it.each(['packer', 'warehouse', 'cashier'])('leaves the %s template unable to change a product', (id) => {
        const allowed = reachable({ role: UserRole.AGENT, permissions: template(id) });
        expect(allowed.filter((name) => writes.some((w) => w.name === name))).toEqual([]);
    });

    it('lets a Packer and a Warehouse member still look products up', () => {
        for (const id of ['packer', 'warehouse']) {
            expect(reachable({ role: UserRole.AGENT, permissions: template(id) })).toEqual(names(reads));
        }
    });

    it('refuses a viewer every change, even holding products.edit', () => {
        expect(reachable({ role: UserRole.VIEWER, permissions: ['section.products', 'products.edit'] })).toEqual(names(reads));
    });

    it('keeps a vendor on the edits opened to it, without the key', () => {
        const opened = writes.filter((r) => Reflect.getMetadata(ALLOW_VENDOR_KEY, r.handler));
        expect(opened.map((r) => r.name)).toEqual(expect.arrayContaining(['update', 'updateVariant', 'bulkUpdateVariants', 'syncToShopify']));
        expect(reachable({ role: UserRole.VENDOR, vendorScope: 'Acme', permissions: [] })).toEqual(
            names([...reads.filter((r) => Reflect.getMetadata(ALLOW_VENDOR_KEY, r.handler)), ...opened]),
        );
    });
});
