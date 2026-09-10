import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { InfluencerAccessGuard } from './guards/influencer-access.guard';
import { AuthController } from './auth.controller';
import { UserController } from '../user/user.controller';
import { OrganizationController } from '../organization/organization.controller';
import { ChannelController } from '../channel/channel.controller';
import { InvitesController } from '../organization/invites.controller';
import { InfluencersController } from '../organization/influencers.controller';
import { OrderController } from '../order/order.controller';

/**
 * INFLUENCER is deny-by-default, which makes the surface opened to them a thing
 * that must be stated rather than discovered. Two failure modes this pins:
 *
 *   - Too closed. The first version of this feature forgot `GET /organizations`
 *     and `POST /auth/switch-org`, which vendors had needed for the same reason:
 *     the client cannot render at all without its memberships, and an influencer
 *     in two organizations could not move between them.
 *   - Too open. If `@AllowInfluencer()` ever leaks onto a whole controller, an
 *     outside party silently gains the organization's orders and team.
 *
 * Runs the REAL guard against the REAL decorator metadata on the REAL
 * controllers, so either mistake fails here rather than in production.
 */

const guard = new InfluencerAccessGuard(new Reflector());

function ctx(handler: (...a: any[]) => any, cls: any, user: any) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => cls,
  } as any;
}

const influencer = { role: UserRole.INFLUENCER, sub: 'u1', orgId: 'o1' };

describe('InfluencerAccessGuard', () => {
  // What an influencer genuinely needs: their session context, their own
  // profile, and the channel routes that let them connect their Instagram.
  const open: Array<[string, (...a: any[]) => any, any]> = [
    ['AuthController.switchOrg', AuthController.prototype.switchOrg, AuthController],
    ['UserController.getProfile', UserController.prototype.getProfile, UserController],
    ['UserController.updateProfile', UserController.prototype.updateProfile, UserController],
    ['UserController.changePassword', UserController.prototype.changePassword, UserController],
    [
      'OrganizationController.findAll',
      OrganizationController.prototype.findAll,
      OrganizationController,
    ],
    [
      'OrganizationController.findOne',
      OrganizationController.prototype.findOne,
      OrganizationController,
    ],
    ['ChannelController.findAll', ChannelController.prototype.findAll, ChannelController],
    ['ChannelController.findOne', ChannelController.prototype.findOne, ChannelController],
    [
      'ChannelController.installInstagram',
      ChannelController.prototype.installInstagram,
      ChannelController,
    ],
    [
      'ChannelController.instagramPending',
      ChannelController.prototype.instagramPending,
      ChannelController,
    ],
    [
      'ChannelController.completeInstagram',
      ChannelController.prototype.completeInstagram,
      ChannelController,
    ],
    ['ChannelController.update', ChannelController.prototype.update, ChannelController],
    ['ChannelController.disconnect', ChannelController.prototype.disconnect, ChannelController],
  ];

  it.each(open)('admits an influencer to %s', (_name, handler, cls) => {
    expect(guard.canActivate(ctx(handler, cls, influencer))).toBe(true);
  });

  // Everything an influencer must never reach. Not exhaustive — it cannot be,
  // since deny-by-default covers the rest — but these are the ones whose
  // accidental opening would matter most.
  const closed: Array<[string, (...a: any[]) => any, any]> = [
    ['InvitesController.send', InvitesController.prototype.send, InvitesController],
    [
      'InvitesController.inviteInfluencer',
      InvitesController.prototype.inviteInfluencer,
      InvitesController,
    ],
    ['InvitesController.resend', InvitesController.prototype.resend, InvitesController],
    ['InvitesController.revoke', InvitesController.prototype.revoke, InvitesController],
    [
      'InfluencersController.findAll',
      InfluencersController.prototype.findAll,
      InfluencersController,
    ],
    ['OrderController.findAll', OrderController.prototype.findAll, OrderController],
    ['ChannelController.installShopify', ChannelController.prototype.installShopify, ChannelController],
    ['ChannelController.triggerSync', ChannelController.prototype.triggerSync, ChannelController],
  ];

  it.each(closed)('refuses an influencer on %s', (_name, handler, cls) => {
    expect(() => guard.canActivate(ctx(handler, cls, influencer))).toThrow(ForbiddenException);
  });

  it('leaves every other role alone', () => {
    for (const role of [
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.MANAGER,
      UserRole.AGENT,
      UserRole.VIEWER,
      UserRole.VENDOR,
    ]) {
      expect(
        guard.canActivate(
          ctx(OrderController.prototype.findAll, OrderController, { role, sub: 'u2' }),
        ),
      ).toBe(true);
    }
  });

  it('does not gate unauthenticated requests', () => {
    // JwtAuthGuard's job, not this one's.
    expect(
      guard.canActivate(ctx(OrderController.prototype.findAll, OrderController, undefined)),
    ).toBe(true);
  });
});
