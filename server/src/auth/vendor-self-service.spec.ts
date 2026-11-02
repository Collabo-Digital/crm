import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { VendorAccessGuard } from './guards/vendor-access.guard';
import { AuthController } from './auth.controller';
import { UserController } from '../user/user.controller';

/**
 * A vendor must be able to end its own session and look after its own login,
 * like every other role. Runs the real guard on the real route metadata.
 */
const guard = new VendorAccessGuard(new Reflector());

function ctx(handler: (...a: any[]) => any, cls: any, user: any) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => cls,
  } as any;
}

const vendor = { role: UserRole.VENDOR, vendorScope: 'Acme', sub: 'u1', orgId: 'o1' };

describe('VendorAccessGuard — own account', () => {
  const open: Array<[string, (...a: any[]) => any, any]> = [
    ['AuthController.logout', AuthController.prototype.logout, AuthController],
    ['UserController.changePassword', UserController.prototype.changePassword, UserController],
    ['UserController.updateProfile', UserController.prototype.updateProfile, UserController],
  ];

  it.each(open)('admits a vendor to %s', (_name, handler, cls) => {
    expect(guard.canActivate(ctx(handler, cls, vendor))).toBe(true);
  });
});
