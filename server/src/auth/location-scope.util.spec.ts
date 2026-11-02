import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import {
  assertInLocationScope,
  inLocationScope,
  locationScopeFor,
  onlyAtLocations,
  removeFromLocationScopes,
  resolveLocationScope,
  scopedLocationFilter,
  scopedLocationSql,
  STORE_SCOPING_UPGRADE,
} from './location-scope.util';

function db(member: { locationScope: string[] } | null = null) {
  return {
    organizationMember: {
      findUnique: jest.fn(() => Promise.resolve(member)),
      findMany: jest.fn(() => Promise.resolve([] as unknown[])),
    },
    teamInvite: { findMany: jest.fn(() => Promise.resolve([] as unknown[])) },
    warehouse: { count: jest.fn(() => Promise.resolve(0)) },
    $executeRaw: jest.fn(() => Promise.resolve(0)),
  };
}

const user = (role: UserRole) => ({ sub: 'u1', orgId: 'org', role });

describe('locationScopeFor', () => {
  it('gives Owners, Admins and Viewers every location without reading the membership', async () => {
    const prisma = db({ locationScope: ['s1'] });
    for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.VIEWER, UserRole.VENDOR, UserRole.INFLUENCER]) {
      expect(await locationScopeFor(prisma as never, user(role))).toBeNull();
    }
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it("returns a Manager's or Agent's locations", async () => {
    const prisma = db({ locationScope: ['s1', 'w2'] });
    expect(await locationScopeFor(prisma as never, user(UserRole.MANAGER))).toEqual(['s1', 'w2']);
    expect(await locationScopeFor(prisma as never, user(UserRole.AGENT))).toEqual(['s1', 'w2']);
    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: 'org', userId: 'u1' } },
      select: { locationScope: true },
    });
  });

  it('reads an empty list as every location, which is what members from before scoping have', async () => {
    expect(await locationScopeFor(db({ locationScope: [] }) as never, user(UserRole.AGENT))).toBeNull();
  });

  it('works nowhere when the membership cannot be found', async () => {
    expect(await locationScopeFor(db(null) as never, user(UserRole.MANAGER))).toEqual([]);
  });

  it('has nothing to limit before the member is in a workspace', async () => {
    expect(await locationScopeFor(db() as never, { sub: 'u1', role: UserRole.AGENT })).toBeNull();
  });
});

describe('scope checks', () => {
  it('allows every location without a scope and only the listed ones with one', () => {
    expect(inLocationScope(null, 's9')).toBe(true);
    expect(inLocationScope(['s1'], 's1')).toBe(true);
    expect(inLocationScope(['s1'], 's9')).toBe(false);
    expect(inLocationScope(['s1'], null)).toBe(false);
    expect(inLocationScope([], 's1')).toBe(false);
  });

  it('refuses a location outside the scope with a 403 and the message given', () => {
    expect(() => assertInLocationScope(['s1'], 's1')).not.toThrow();
    expect(() => assertInLocationScope(['s1'], 's2', 'Not your store.')).toThrow(new ForbiddenException('Not your store.'));
  });

  it('narrows a list filter to the scope, and a location outside it to nothing', () => {
    expect(scopedLocationFilter(null)).toBeUndefined();
    expect(scopedLocationFilter(null, 's9')).toBe('s9');
    expect(scopedLocationFilter(['s1', 's2'])).toEqual({ in: ['s1', 's2'] });
    expect(scopedLocationFilter(['s1', 's2'], 's2')).toBe('s2');
    expect(scopedLocationFilter(['s1', 's2'], 's9')).toEqual({ in: [] });
  });

  it('builds the same filter for raw SQL', () => {
    const column = Prisma.sql`sl."warehouse_id"`;
    expect(scopedLocationSql(column, null)).toBe(Prisma.empty);
    const one = scopedLocationSql(column, null, 's9');
    expect(one.sql).toBe('AND sl."warehouse_id" = ?');
    expect(one.values).toEqual(['s9']);
    const scoped = scopedLocationSql(column, ['s1', 's2']);
    expect(scoped.sql).toBe('AND sl."warehouse_id" = ANY(?::text[])');
    expect(scoped.values).toEqual([['s1', 's2']]);
    expect(scopedLocationSql(column, ['s1'], 's9').values).toEqual([[]]);
  });
});

describe('resolveLocationScope', () => {
  it("keeps the org's own locations, each once", async () => {
    const prisma = db();
    prisma.warehouse.count.mockResolvedValue(2);
    expect(await resolveLocationScope(prisma as never, 'org', UserRole.MANAGER, ['s1', 'w2', 's1'], true)).toEqual(['s1', 'w2']);
    expect(prisma.warehouse.count).toHaveBeenCalledWith({ where: { organizationId: 'org', id: { in: ['s1', 'w2'] } } });
  });

  it("refuses a location that is not the org's", async () => {
    const prisma = db();
    prisma.warehouse.count.mockResolvedValue(1);
    await expect(resolveLocationScope(prisma as never, 'org', UserRole.AGENT, ['s1', 'other-org'], true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a scope for roles it does not apply to', async () => {
    for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.VIEWER, UserRole.VENDOR]) {
      await expect(resolveLocationScope(db() as never, 'org', role, ['s1'], true)).rejects.toThrow(
        'Only managers and agents can be limited to stores.',
      );
    }
  });

  it('refuses a scope on a plan without store scoping, with the upgrade note', async () => {
    await expect(resolveLocationScope(db() as never, 'org', UserRole.MANAGER, ['s1'], false)).rejects.toThrow(
      new ForbiddenException(STORE_SCOPING_UPGRADE),
    );
  });

  it('always lets a scope be cleared, for any role and on any plan', async () => {
    const prisma = db();
    expect(await resolveLocationScope(prisma as never, 'org', UserRole.VIEWER, [], false)).toEqual([]);
    expect(await resolveLocationScope(prisma as never, 'org', UserRole.OWNER, undefined, false)).toEqual([]);
    expect(prisma.warehouse.count).not.toHaveBeenCalled();
  });

});

describe('closing a location', () => {
  it('names the members and invitations that work only there', async () => {
    const prisma = db();
    prisma.organizationMember.findMany.mockResolvedValue([
      { locationScope: ['s1'], user: { firstName: 'Priya', lastName: 'Sharma', email: 'priya@x.in' } },
      { locationScope: ['s1', 's2'], user: { firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@x.in' } },
    ]);
    prisma.teamInvite.findMany.mockResolvedValue([
      { locationScope: ['s1'], email: 'new@x.in', name: null },
      { locationScope: ['s1'], email: 'anu@x.in', name: 'Anu' },
    ]);
    expect(await onlyAtLocations(prisma as never, 'org', ['s1'])).toEqual(['Priya Sharma', 'new@x.in', 'Anu']);
    expect(prisma.organizationMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org',
          isActive: true,
          role: { in: [UserRole.MANAGER, UserRole.AGENT] },
          locationScope: { hasSome: ['s1'] },
        },
      }),
    );
  });

  it('takes the locations out of every member and invitation scope in the org', async () => {
    const prisma = db();
    await removeFromLocationScopes(prisma as never, 'org', ['s1']);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    // The tagged template's text, with nested fragments spelled out.
    const text = (call: unknown[]) => {
      const [strings, ...values] = call as [string[], ...unknown[]];
      return strings
        .map((s, i) => {
          const value = values[i] as { sql?: string } | undefined;
          return s + (i < values.length ? (typeof value?.sql === 'string' ? value.sql : '?') : '');
        })
        .join('');
    };
    const [members, invites] = (prisma.$executeRaw.mock.calls as unknown[][]).map(text);
    expect(members).toContain('UPDATE "organization_members"');
    expect(invites).toContain('UPDATE "team_invites"');
    // A Manager or Agent left with nothing would work everywhere: they keep it.
    expect(members).toContain(`"role" NOT IN ('MANAGER', 'AGENT') OR NOT ("location_scope" <@`);
  });

  it('does nothing for no locations', async () => {
    const prisma = db();
    await removeFromLocationScopes(prisma as never, 'org', []);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
