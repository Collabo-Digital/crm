import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { PermissionsGuard } from './permissions.guard';
import { RequireAnyPermission, RequirePermissions } from '../decorators/require-permissions.decorator';
import type { PermissionKey } from '../permissions';

function contextFor(user: Record<string, unknown> | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  let reflector: Reflector;
  let guard: PermissionsGuard;
  let required: PermissionKey[] | undefined;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(() => required),
    } as unknown as Reflector;
    guard = new PermissionsGuard(reflector);
  });

  it('allows any route without @RequirePermissions (allow-by-default)', () => {
    required = undefined;
    expect(guard.canActivate(contextFor({ role: UserRole.VIEWER }))).toBe(true);
  });

  it('grants OWNER/ADMIN/MANAGER implicitly', () => {
    required = ['inventory.adjust'];
    for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER]) {
      expect(guard.canActivate(contextFor({ role, permissions: [] }))).toBe(true);
    }
  });

  it('grants AGENT only the keys in their permissions array', () => {
    required = ['inventory.pick'];
    expect(
      guard.canActivate(
        contextFor({ role: UserRole.AGENT, permissions: ['inventory.view', 'inventory.pick'] }),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        contextFor({ role: UserRole.AGENT, permissions: ['inventory.view'] }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('requires ALL listed keys, not any', () => {
    required = ['inventory.view', 'inventory.adjust'];
    expect(() =>
      guard.canActivate(
        contextFor({ role: UserRole.AGENT, permissions: ['inventory.view'] }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('lets a VIEWER through with an explicit grant', () => {
    required = ['reports.finance'];
    expect(
      guard.canActivate(
        contextFor({ role: UserRole.VIEWER, permissions: ['reports.finance'] }),
      ),
    ).toBe(true);
  });

  it('always refuses VENDOR, even with grants', () => {
    required = ['inventory.view'];
    expect(() =>
      guard.canActivate(
        contextFor({ role: UserRole.VENDOR, permissions: ['inventory.view'] }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('denies when there is no session role', () => {
    required = ['inventory.view'];
    expect(guard.canActivate(contextFor(undefined))).toBe(false);
    expect(guard.canActivate(contextFor({}))).toBe(false);
  });

  it('treats a missing permissions array as no grants', () => {
    required = ['inventory.view'];
    expect(() =>
      guard.canActivate(contextFor({ role: UserRole.AGENT })),
    ).toThrow(ForbiddenException);
  });
});

describe('PermissionsGuard with @RequireAnyPermission', () => {
  class Stock {
    @RequireAnyPermission('inventory.adjust', 'inventory.receive')
    adjust() {}
    @RequirePermissions('inventory.view')
    @RequireAnyPermission('inventory.adjust', 'inventory.receive')
    both() {}
  }
  const guard = new PermissionsGuard(new Reflector());
  const run = (handler: () => void, user: Record<string, unknown>) =>
    guard.canActivate({
      getHandler: () => handler,
      getClass: () => Stock,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext);

  it('passes on any one of the keys', () => {
    expect(run(Stock.prototype.adjust, { role: UserRole.AGENT, permissions: ['inventory.receive'] })).toBe(true);
    expect(run(Stock.prototype.adjust, { role: UserRole.AGENT, permissions: ['inventory.adjust'] })).toBe(true);
  });

  it('refuses none of them, naming both', () => {
    expect(() => run(Stock.prototype.adjust, { role: UserRole.AGENT, permissions: ['inventory.view'] })).toThrow(
      new ForbiddenException('Missing permission: inventory.adjust or inventory.receive'),
    );
  });

  it('still asks for every key of @RequirePermissions beside it', () => {
    expect(() => run(Stock.prototype.both, { role: UserRole.AGENT, permissions: ['inventory.receive'] })).toThrow(ForbiddenException);
    expect(run(Stock.prototype.both, { role: UserRole.AGENT, permissions: ['inventory.view', 'inventory.receive'] })).toBe(true);
  });

  it('lets managers through and keeps vendors out', () => {
    expect(run(Stock.prototype.adjust, { role: UserRole.MANAGER, permissions: [] })).toBe(true);
    expect(() => run(Stock.prototype.adjust, { role: UserRole.VENDOR, permissions: ['inventory.receive'] })).toThrow(ForbiddenException);
  });
});
