import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  REQUIRE_SECTION_KEY,
  SECTION_OR_PERMISSION_KEY,
} from '../decorators/require-section.decorator';
import { hasPermission, PermissionKey, resolveSections, SectionKey } from '../permissions';
import { SessionPayload } from '../interfaces/jwt-payload.interface';

/**
 * Enforces `@RequireSection(...)`. Allow-by-default: routes without the
 * decorator (or with an empty one) are untouched.
 *
 * Resolution (see `resolveSections`):
 *   - OWNER / ADMIN / MANAGER and VENDOR pass — vendors are already governed
 *     by VendorAccessGuard and their vendor scope.
 *   - AGENT / VIEWER with no `section.*` grant pass (not configured yet).
 *   - Otherwise the member must hold ANY of the listed sections, or the
 *     permission a `@SectionOrPermission(...)` route also opens to.
 *
 * The message prefix "Section access denied" is matched by the client to
 * re-sync the member's access, so keep it stable.
 */
@Injectable()
export class SectionAccessGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<SectionKey[]>(REQUIRE_SECTION_KEY, targets);
    if (!required || required.length === 0) return true;

    const user = context
      .switchToHttp()
      .getRequest<{ user?: SessionPayload }>().user;
    if (!user?.role) return false;

    const sections = resolveSections(user.role, user.permissions ?? []);
    if (sections === 'all') return true;
    if (required.some((key) => sections.has(key))) return true;

    const opener = this.reflector.getAllAndOverride<PermissionKey | undefined>(SECTION_OR_PERMISSION_KEY, targets);
    if (opener && hasPermission(user.role, user.permissions, opener)) return true;

    throw new ForbiddenException(
      `Section access denied: ${required[0].replace('section.', '')}`,
    );
  }
}
