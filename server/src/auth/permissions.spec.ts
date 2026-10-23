import { UserRole } from '@prisma/client';
import {
    defaultGrantsForRole,
    hasPermission,
    extractGrants,
    DEFAULT_ROLE_GRANTS,
    PERMISSION_KEYS,
} from './permissions';

/**
 * Pins the influencer permission model.
 *
 * The requirement that influencers reach the Campaign section is explicitly
 * TEMPORARY. These tests exist to keep that decision expressible as data: the
 * grant is looked up, never inferred from the role, so narrowing it later is an
 * edit to DEFAULT_ROLE_GRANTS and nothing else.
 */
describe('influencer permissions', () => {
    it('starts an influencer with campaign viewing and nothing more', () => {
        expect(defaultGrantsForRole(UserRole.INFLUENCER)).toEqual(['campaigns.view']);
    });

    it('does not let an influencer act in campaigns, only see them', () => {
        const grants = defaultGrantsForRole(UserRole.INFLUENCER);
        expect(hasPermission(UserRole.INFLUENCER, grants, 'campaigns.view')).toBe(true);
        expect(hasPermission(UserRole.INFLUENCER, grants, 'campaigns.manage')).toBe(false);
    });

    it('keeps an influencer out of every unrelated capability', () => {
        const grants = defaultGrantsForRole(UserRole.INFLUENCER);
        for (const key of PERMISSION_KEYS) {
            if (key === 'campaigns.view') continue;
            expect(hasPermission(UserRole.INFLUENCER, grants, key)).toBe(false);
        }
    });

    it('grants nothing by default to the roles that need no seed', () => {
        // Absent from the map on purpose: OWNER/ADMIN/MANAGER hold everything
        // implicitly, and seeding a list for them would imply it is exhaustive.
        expect(defaultGrantsForRole(UserRole.OWNER)).toEqual([]);
        expect(defaultGrantsForRole(UserRole.AGENT)).toEqual([]);
    });

    it('hands back a copy, so a caller cannot mutate the shared default', () => {
        const first = defaultGrantsForRole(UserRole.INFLUENCER);
        first.push('reports.finance');
        expect(defaultGrantsForRole(UserRole.INFLUENCER)).toEqual(['campaigns.view']);
        expect(DEFAULT_ROLE_GRANTS[UserRole.INFLUENCER]).toEqual(['campaigns.view']);
    });

    it('narrowing campaign access later needs no code change beyond the map', () => {
        // Demonstrates the future-proofing: revoke by removing the grant, and
        // the same resolution answers false. Nothing branches on the role.
        expect(hasPermission(UserRole.INFLUENCER, [], 'campaigns.view')).toBe(false);
    });
});

describe('hasPermission', () => {
    it('gives owners, admins and managers every key implicitly', () => {
        for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]) {
            expect(hasPermission(role, [], 'campaigns.view')).toBe(true);
            expect(hasPermission(role, [], 'reports.finance')).toBe(true);
        }
    });

    it('gives a vendor nothing, whatever its grants say', () => {
        expect(hasPermission(UserRole.VENDOR, ['campaigns.view'], 'campaigns.view')).toBe(false);
    });

    it('resolves an agent from its grants alone', () => {
        expect(hasPermission(UserRole.AGENT, ['inventory.pick'], 'inventory.pick')).toBe(true);
        expect(hasPermission(UserRole.AGENT, ['inventory.pick'], 'inventory.pack')).toBe(false);
    });

    it('refuses when there is no role at all', () => {
        expect(hasPermission(undefined, ['campaigns.view'], 'campaigns.view')).toBe(false);
    });
});

describe('extractGrants', () => {
    it('accepts the campaign keys now that they are real', () => {
        expect(extractGrants({ grants: ['campaigns.view', 'campaigns.manage'] })).toEqual([
            'campaigns.view',
            'campaigns.manage',
        ]);
    });

    it('drops anything that is not a known key', () => {
        expect(extractGrants({ grants: ['campaigns.view', 'campaigns.destroy', 42] })).toEqual([
            'campaigns.view',
        ]);
    });
});
