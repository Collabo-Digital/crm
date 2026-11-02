import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { SectionAccessGuard } from './section-access.guard';
import { RequireSection, REQUIRE_SECTION_KEY, SectionOrPermission } from '../decorators/require-section.decorator';
import { buildSessionPayload } from '../session-payload.util';
import type { SectionKey } from '../permissions';

function contextFor(user: Record<string, unknown> | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('SectionAccessGuard', () => {
  let guard: SectionAccessGuard;
  let required: SectionKey[] | undefined;

  beforeEach(() => {
    const reflector = {
      getAllAndOverride: jest.fn(() => required),
    } as unknown as Reflector;
    guard = new SectionAccessGuard(reflector);
  });

  it('allows any route without @RequireSection', () => {
    required = undefined;
    expect(
      guard.canActivate(contextFor({ role: UserRole.AGENT, permissions: ['section.orders'] })),
    ).toBe(true);
  });

  it('treats an empty @RequireSection() as lifted', () => {
    required = [];
    expect(
      guard.canActivate(contextFor({ role: UserRole.AGENT, permissions: ['section.orders'] })),
    ).toBe(true);
  });

  it('lets OWNER / ADMIN / MANAGER through whatever their grants say', () => {
    required = ['section.invoices'];
    for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]) {
      expect(
        guard.canActivate(contextFor({ role, permissions: ['section.orders'] })),
      ).toBe(true);
    }
  });

  it('leaves VENDOR to the vendor guards', () => {
    required = ['section.orders'];
    expect(guard.canActivate(contextFor({ role: UserRole.VENDOR, permissions: [] }))).toBe(true);
  });

  it('keeps members with no section grant unrestricted (joined before the feature)', () => {
    required = ['section.dashboard'];
    expect(guard.canActivate(contextFor({ role: UserRole.AGENT }))).toBe(true);
    expect(
      guard.canActivate(contextFor({ role: UserRole.VIEWER, permissions: ['inventory.view'] })),
    ).toBe(true);
  });

  it('passes when the member holds ANY listed section', () => {
    required = ['section.products', 'section.orders'];
    expect(
      guard.canActivate(contextFor({ role: UserRole.AGENT, permissions: ['section.orders'] })),
    ).toBe(true);
  });

  it('refuses a configured member without the section', () => {
    required = ['section.dashboard'];
    expect(() =>
      guard.canActivate(
        contextFor({ role: UserRole.AGENT, permissions: ['section.orders', 'section.customers'] }),
      ),
    ).toThrow(new ForbiddenException('Section access denied: dashboard'));
  });

  it('denies when there is no session role', () => {
    required = ['section.orders'];
    expect(guard.canActivate(contextFor(undefined))).toBe(false);
  });
});

describe('RequireSection', () => {
  it('stores prefixed keys, and the handler-level one overrides the class', () => {
    @RequireSection('orders')
    class Ctrl {
      @RequireSection('orders', 'customers')
      shared() {}
      @RequireSection()
      lifted() {}
      plain() {}
    }
    const reflector = new Reflector();
    const read = (handler: () => void) =>
      reflector.getAllAndOverride(REQUIRE_SECTION_KEY, [handler, Ctrl]);

    expect(read(Ctrl.prototype.shared)).toEqual(['section.orders', 'section.customers']);
    expect(read(Ctrl.prototype.lifted)).toEqual([]);
    expect(read(Ctrl.prototype.plain)).toEqual(['section.orders']);
  });
});

describe('SectionOrPermission', () => {
  @RequireSection('orders')
  class Till {
    @SectionOrPermission('pos.sell')
    sell() {}
    settings() {}
  }
  const guard = new SectionAccessGuard(new Reflector());
  const run = (handler: () => void, user: Record<string, unknown>) => {
    const context = {
      getHandler: () => handler,
      getClass: () => Till,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    try {
      return guard.canActivate(context);
    } catch (err) {
      if (err instanceof ForbiddenException) return false;
      throw err;
    }
  };

  it('opens the route to a member holding the permission without the section', () => {
    expect(run(Till.prototype.sell, { role: UserRole.AGENT, permissions: ['section.products', 'pos.sell'] })).toBe(true);
  });

  it('still opens it to the section, as before', () => {
    expect(run(Till.prototype.sell, { role: UserRole.AGENT, permissions: ['section.orders'] })).toBe(true);
  });

  it('opens nothing else in the section', () => {
    expect(run(Till.prototype.settings, { role: UserRole.AGENT, permissions: ['section.products', 'pos.sell'] })).toBe(false);
  });

  it('refuses a member with neither', () => {
    expect(run(Till.prototype.sell, { role: UserRole.AGENT, permissions: ['section.products', 'inventory.pack'] })).toBe(false);
  });
});

describe('buildSessionPayload', () => {
  it('caches the grants of the current org and of every membership', () => {
    const a = {
      organizationId: 'org-a', role: UserRole.AGENT, vendorScope: null,
      permissions: { grants: ['section.orders', 'not.a.key'] },
    };
    const b = { organizationId: 'org-b', role: UserRole.ADMIN, vendorScope: null, permissions: null };

    const session = buildSessionPayload(
      { id: 'u1', email: 'a@b.c', emailVerified: true },
      a,
      [a, b],
      { isSuperAdmin: false },
    );

    expect(session).toMatchObject({
      orgId: 'org-a',
      permissions: ['section.orders'],
      memberships: [
        { orgId: 'org-a', permissions: ['section.orders'] },
        { orgId: 'org-b', permissions: [] },
      ],
    });
    expect(session).not.toHaveProperty('impersonatedBy');
  });
});
