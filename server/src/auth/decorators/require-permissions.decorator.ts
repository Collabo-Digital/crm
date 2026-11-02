import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../permissions';

export const REQUIRE_PERMISSIONS_KEY = 'requirePermissions';
export const REQUIRE_ANY_PERMISSION_KEY = 'requireAnyPermission';

/**
 * Require fine-grained permission keys on top of `@Roles(...)`.
 *
 * `PermissionsGuard` is ALLOW-by-default: a route without this decorator is
 * untouched. With it, the request passes when the session role implicitly
 * holds everything (OWNER/ADMIN/MANAGER) or the membership's `grants` contain
 * ALL listed keys.
 *
 * Always pair with an explicit `@Roles(...)` — this decorator narrows within
 * the allowed roles, it does not replace role gating (RolesGuard is
 * allow-by-default, so a route with only `@RequirePermissions` would still let
 * an ungranted MANAGER through by design but also skip the roles audit).
 */
export const RequirePermissions = (...keys: PermissionKey[]) =>
  SetMetadata(REQUIRE_PERMISSIONS_KEY, keys);

/**
 * Like `@RequirePermissions`, but ANY one listed key is enough. For a route
 * two jobs share, where the handler narrows what the lesser key may do: stock
 * adjustments take `inventory.adjust`, or `inventory.receive` for goods in.
 */
export const RequireAnyPermission = (...keys: PermissionKey[]) =>
  SetMetadata(REQUIRE_ANY_PERMISSION_KEY, keys);
