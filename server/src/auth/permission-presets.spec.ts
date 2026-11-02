import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PERMISSION_KEYS, PERMISSION_PRESETS, resolveSections, SECTION_KEYS } from './permissions';
import { MembersController } from '../organization/members.controller';

/**
 * The job templates on the team screen. The client reads them from the API
 * and keeps no copy, so these are the rules a template must keep wherever it
 * is shown.
 */

/**
 * The grants billed as an ops seat (packing or till-only): an active AGENT
 * whose grants all fall in this set. Mirrors the rule in billing.
 */
const OPS_SEAT_GRANTS = new Set<string>([
    'section.products',
    'inventory.view',
    'inventory.pack',
    'inventory.pick',
    'inventory.receive',
    'inventory.dispatch',
    'inventory.labels',
    'pos.sell',
]);

const byId = (id: string) => {
    const preset = PERMISSION_PRESETS.find((p) => p.id === id);
    if (!preset) throw new Error(`no ${id} template`);
    return preset;
};

describe('job templates', () => {
    it('are the six jobs the team screen offers', () => {
        expect(PERMISSION_PRESETS.map((p) => p.id)).toEqual(['support', 'marketing', 'accountant', 'warehouse', 'packer', 'cashier']);
    });

    it.each(PERMISSION_PRESETS.map((p) => [p.label, p] as const))('%s grants known keys, once each, and says what it is', (_label, preset) => {
        expect(preset.grants.every((key) => (PERMISSION_KEYS as readonly string[]).includes(key))).toBe(true);
        expect(new Set(preset.grants).size).toBe(preset.grants.length);
        expect(preset.label.length).toBeGreaterThan(0);
        expect(preset.description.length).toBeGreaterThan(20);
    });

    it.each(PERMISSION_PRESETS.map((p) => [p.label, p] as const))('%s names a section, so it is never full access', (_label, preset) => {
        expect(preset.grants.some((key) => (SECTION_KEYS as readonly string[]).includes(key))).toBe(true);
        expect(resolveSections(UserRole.AGENT, preset.grants)).not.toBe('all');
    });

    it.each(['packer', 'warehouse', 'cashier'])('the %s stays within an ops seat', (id) => {
        expect(byId(id).grants.filter((key) => !OPS_SEAT_GRANTS.has(key))).toEqual([]);
    });

    it('an Accountant reads the money and nothing that changes orders', () => {
        const { grants } = byId('accountant');
        expect(grants).toEqual(expect.arrayContaining(['section.invoices', 'section.analytics', 'reports.finance']));
        expect(grants).not.toContain('section.orders');
        expect(grants.some((key) => key.startsWith('chat.') || key === 'section.chat')).toBe(false);
    });

    it('Marketing can open Campaigns: the section needs campaigns.view beside it', () => {
        expect(byId('marketing').grants).toEqual(
            expect.arrayContaining(['section.campaigns', 'campaigns.view', 'campaigns.manage', 'broadcasts.send', 'templates.manage']),
        );
    });

    it('a Warehouse member receives, picks, packs, dispatches and labels, but does not correct counts', () => {
        expect(byId('warehouse').grants).toEqual(
            expect.arrayContaining(['inventory.view', 'inventory.receive', 'inventory.pick', 'inventory.pack', 'inventory.dispatch', 'inventory.labels']),
        );
        expect(byId('warehouse').grants).not.toContain('inventory.adjust');
    });

    it('a Cashier gets the till and no Orders section', () => {
        expect(byId('cashier').grants).toContain('pos.sell');
        expect(byId('cashier').grants).not.toContain('section.orders');
    });
});

describe('GET /organizations/:orgId/members/job-templates', () => {
    it('serves the templates to an owner or admin', async () => {
        const orgs = { requireRole: jest.fn(() => Promise.resolve({ role: UserRole.ADMIN })) };
        const controller = new MembersController({} as never, orgs as never);

        await expect(controller.jobTemplates('org_1', { sub: 'u1', email: 'a@test.local' })).resolves.toBe(PERMISSION_PRESETS);
        expect(orgs.requireRole).toHaveBeenCalledWith('org_1', 'u1', [UserRole.OWNER, UserRole.ADMIN]);
    });

    it('refuses anyone else', async () => {
        const orgs = { requireRole: jest.fn(() => Promise.reject(new ForbiddenException('Insufficient permissions'))) };
        const controller = new MembersController({} as never, orgs as never);

        await expect(controller.jobTemplates('org_1', { sub: 'u2', email: 'b@test.local' })).rejects.toBeInstanceOf(ForbiddenException);
    });
});
