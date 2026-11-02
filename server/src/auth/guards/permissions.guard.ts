import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ALLOW_VENDOR_KEY } from '../decorators/allow-vendor.decorator';
import {
  REQUIRE_ANY_PERMISSION_KEY,
  REQUIRE_PERMISSIONS_KEY,
} from '../decorators/require-permissions.decorator';
import { IMPLICIT_ALL_ROLES, PermissionKey } from '../permissions';
import { SessionPayload } from '../interfaces/jwt-payload.interface';

/**
 * Enforces `@RequirePermissions(...)` and `@RequireAnyPermission(...)`.
 * Allow-by-default: routes without either are untouched (RolesGuard and
 * VendorAccessGuard already ran).
 *
 * Resolution:
 *   - OWNER / ADMIN / MANAGER pass every check (implicit full grant).
 *   - AGENT / VIEWER pass when the session's `permissions` (loaded from
 *     OrganizationMember.permissions by JwtStrategy, Redis-cached alongside
 *     role) contain ALL required keys, and at least one of the any-of keys.
 *   - VENDOR holds no keys: it passes only a route opened to it with
 *     `@AllowVendor()`, where its vendor scope is what confines it (a vendor
 *     edits its own products without `products.edit`). Everywhere else it is
 *     refused — floor access for vendors is a V2 question.
 *
 * Freshness: permission edits go through the member PATCH endpoint, which
 * already calls `redis.deleteSession(userId)` — the same staleness story as
 * role changes.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRE_PERMISSIONS_KEY, targets) ?? [];
    const anyOf = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRE_ANY_PERMISSION_KEY, targets) ?? [];
    if (required.length === 0 && anyOf.length === 0) return true;

    const user = context
      .switchToHttp()
      .getRequest<{ user?: SessionPayload }>().user;
    if (!user?.role) return false;

    if (user.role === UserRole.VENDOR) {
      if (this.reflector.getAllAndOverride<boolean>(ALLOW_VENDOR_KEY, targets)) return true;
      throw new ForbiddenException('Vendors cannot access inventory operations.');
    }
    if (IMPLICIT_ALL_ROLES.includes(user.role)) return true;

    const held = new Set(user.permissions ?? []);
    const missing = required.filter((key) => !held.has(key));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      );
    }
    if (anyOf.length > 0 && !anyOf.some((key) => held.has(key))) {
      throw new ForbiddenException(`Missing permission: ${anyOf.join(' or ')}`);
    }
    return true;
  }
}
