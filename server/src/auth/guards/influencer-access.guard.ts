import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_INFLUENCER_KEY } from '../decorators/allow-influencer.decorator';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * Deny-by-default access control for the INFLUENCER role.
 *
 * Modelled on `VendorAccessGuard`, and for the same reason: an influencer is an
 * OUTSIDE party who happens to hold a membership in the organization. Because
 * `RolesGuard` is allow-by-default, without this guard an influencer would reach
 * every endpoint that simply forgot to declare `@Roles(...)` — which is most
 * read endpoints in the app, including the org's orders, customers and revenue.
 *
 * Non-influencer roles are unaffected (returns true immediately).
 *
 * Note what this guard does NOT do: it does not decide which channels an
 * influencer may act on. Route-level access says "you may call this endpoint";
 * ownership (`Channel.ownerUserId`) says "on this row", and that is enforced in
 * ChannelService where the row is actually loaded.
 */
@Injectable()
export class InfluencerAccessGuard implements CanActivate {
  constructor(private reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {
    // @Public() routes (login, invite accept, OAuth callbacks …) are never gated here.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const user = context.switchToHttp().getRequest<{ user?: JwtPayload }>().user;
    if (!user || user.role !== UserRole.INFLUENCER) return true; // only constrains influencers

    const allowInfluencer = this.reflector.getAllAndOverride<boolean>(ALLOW_INFLUENCER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowInfluencer) {
      throw new ForbiddenException('Influencers cannot access this resource.');
    }
    return true;
  }
}
