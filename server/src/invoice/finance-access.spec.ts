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
import { ROLES_KEY, ORG_MANAGERS } from '../auth/decorators/roles.decorator';
import { PERMISSION_PRESETS } from '../auth/permissions';
import { InwardSupplyController } from '../inward-supply/inward-supply.controller';
import { InvoiceController } from './invoice.controller';

/**
 * Who reads the money, through the app's global guards in their app.module
 * order: invoices (list, detail, PDF, exports), GST returns with their HSN
 * export and filings, and payment fees. Reading needs reports.finance on top
 * of the Invoices section; owners, admins and managers hold it implicitly,
 * and every write stays with them.
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

type Route = { controller: { prototype: object; name: string }; name: string; handler: (...a: unknown[]) => unknown; read: boolean };

const routes: Route[] = [InvoiceController, InwardSupplyController].flatMap((controller) => {
    const proto = controller.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    return Object.getOwnPropertyNames(proto)
        .filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined)
        .map((name) => ({
            controller,
            name,
            handler: proto[name],
            read: Reflect.getMetadata(METHOD_METADATA, proto[name]) === RequestMethod.GET,
        }));
});
const reads = routes.filter((r) => r.read);
const writes = routes.filter((r) => !r.read);

function reaches(user: Record<string, unknown>, route: Route): boolean {
    const ctx = {
        getHandler: () => route.handler,
        getClass: () => route.controller,
        switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u1', orgId: 'org_1', ...user } }) }),
    } as unknown as ExecutionContext;
    try {
        return guards.every((g) => g.canActivate(ctx));
    } catch {
        return false;
    }
}

const names = (list: Array<Pick<Route, 'controller' | 'name'>>) => list.map((r) => `${r.controller.name}.${r.name}`).sort();
const reachable = (user: Record<string, unknown>) => names(routes.filter((r) => reaches(user, r)));
const ACCOUNTANT = PERMISSION_PRESETS.find((p) => p.id === 'accountant')!.grants;

describe('finance route access', () => {
    it('covers the invoice, GST-return and payment-fee reads', () => {
        expect(names(reads)).toEqual(
            names([
                ...['getStats', 'getGstReturn', 'exportGstReturnCsv', 'exportCsv', 'exportJson', 'listRefundsNeedingCreditNote', 'findAll', 'pdf', 'findOne', 'listFilings'].map(
                    (name) => ({ controller: InvoiceController, name }),
                ),
                { controller: InwardSupplyController, name: 'list' },
            ]),
        );
    });

    it.each(writes.map((r) => [`${r.controller.name}.${r.name}`, r] as const))('%s stays with managers', (_name, route) => {
        expect(Reflect.getMetadata(ROLES_KEY, route.handler)).toEqual(ORG_MANAGERS);
    });

    it('lets owners, admins and managers do everything', () => {
        for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]) {
            expect(reachable({ role, permissions: [] })).toEqual(names(routes));
        }
    });

    it('lets an Accountant read every one of them and change none', () => {
        expect(reachable({ role: UserRole.AGENT, permissions: ACCOUNTANT })).toEqual(names(reads));
    });

    it('lets a viewer holding reports.finance read them too', () => {
        expect(reachable({ role: UserRole.VIEWER, permissions: ['section.invoices', 'reports.finance'] })).toEqual(names(reads));
    });

    it('refuses the Invoices section without reports.finance', () => {
        expect(reachable({ role: UserRole.AGENT, permissions: ['section.invoices'] })).toEqual([]);
        expect(reachable({ role: UserRole.VIEWER, permissions: ['section.invoices', 'section.orders'] })).toEqual([]);
    });

    it('refuses reports.finance without the Invoices section', () => {
        expect(reachable({ role: UserRole.AGENT, permissions: ['section.analytics', 'reports.finance'] })).toEqual([]);
    });

    it('treats a member with no section (joined before section access) by the key alone', () => {
        expect(reachable({ role: UserRole.AGENT, permissions: ['reports.finance'] })).toEqual(names(reads));
        expect(reachable({ role: UserRole.AGENT, permissions: [] })).toEqual([]);
    });

    it('keeps vendors and influencers out, whatever they hold', () => {
        expect(reachable({ role: UserRole.VENDOR, vendorScope: 'Acme', permissions: ['section.invoices', 'reports.finance'] })).toEqual([]);
        expect(reachable({ role: UserRole.INFLUENCER, permissions: ['section.invoices', 'reports.finance'] })).toEqual([]);
    });
});
