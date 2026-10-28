import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { ACTIVE_MEMBERSHIP } from '../auth/active-membership';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { OrganizationService } from './organization.service';

/**
 * Deleting a workspace only sets `deletedAt`; its member rows stay active.
 * Every access path therefore has to treat a deleted workspace as closed —
 * members used to keep reading and changing it after it was "deleted".
 */
/** The owner's password, hashed cheaply for tests. */
const PASSWORD_HASH = bcrypt.hashSync('owner-password', 4);
const CONFIRMED = { password: 'owner-password', confirmName: 'A' };

describe('A deleted workspace is closed to its members', () => {
  describe('OrganizationService', () => {
    function build(deletedAt: Date | null) {
      const membership = {
        isActive: true,
        role: UserRole.OWNER,
        organization: { id: 'org-a', name: 'A', slug: 'a', deletedAt },
      };
      const updateMany = () => jest.fn().mockResolvedValue({ count: 1 });
      const prisma = {
        organizationMember: {
          findUnique: jest.fn().mockResolvedValue(membership),
          findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]),
        },
        organization: {
          update: jest.fn().mockResolvedValue({ id: 'org-a' }),
          findUnique: jest.fn().mockResolvedValue({ name: 'A' }),
        },
        user: { findUnique: jest.fn().mockResolvedValue({ password: PASSWORD_HASH }) },
        apiKey: { updateMany: updateMany() },
        webhookEndpoint: { updateMany: updateMany() },
        broadcast: { updateMany: updateMany() },
        broadcastRecipient: { updateMany: updateMany() },
        automation: { updateMany: updateMany() },
        automationTrigger: { updateMany: updateMany() },
        $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      };
      const redis = { deleteSession: jest.fn().mockResolvedValue(undefined) };
      const billing = { cancelOrganizationSubscription: jest.fn().mockResolvedValue(undefined) };
      const channels = { disconnectAllForOrg: jest.fn().mockResolvedValue(undefined) };
      const service = new OrganizationService(prisma as never, billing as never, redis as never, channels as never);
      return { service, prisma, redis, billing, channels };
    }

    it('refuses role checks for a deleted workspace, even for its owner', async () => {
      const { service } = build(new Date());

      await expect(service.requireRole('org-a', 'u1', [UserRole.OWNER])).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to return a deleted workspace', async () => {
      const { service } = build(new Date());

      await expect(service.findOne('org-a', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to update a deleted workspace', async () => {
      const { service, prisma } = build(new Date());

      await expect(service.update('org-a', 'u1', { name: 'New' } as never)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.organization.update).not.toHaveBeenCalled();
    });

    it('still allows a live workspace', async () => {
      const { service } = build(null);

      await expect(service.requireRole('org-a', 'u1', [UserRole.OWNER])).resolves.toMatchObject({ role: UserRole.OWNER });
    });

    it("drops every member's cached session when the workspace is deleted", async () => {
      const { service, prisma, redis } = build(null);

      await service.delete('org-a', 'u1', CONFIRMED);

      expect(prisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'org-a' }, data: { deletedAt: expect.any(Date) as Date } }),
      );
      expect(redis.deleteSession).toHaveBeenCalledWith('u1');
      expect(redis.deleteSession).toHaveBeenCalledWith('u2');
    });

    it('switches off everything that acts for the workspace when it is deleted', async () => {
      const { service, prisma, billing, channels } = build(null);

      await service.delete('org-a', 'u1', CONFIRMED);

      expect(billing.cancelOrganizationSubscription).toHaveBeenCalledWith('org-a');
      // Releases the WhatsApp number and Shopify store, and stops their webhooks.
      expect(channels.disconnectAllForOrg).toHaveBeenCalledWith('org-a');
      expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', revokedAt: null },
        data: { revokedAt: expect.any(Date) as Date },
      });
      expect(prisma.webhookEndpoint.updateMany.mock.calls[0][0]).toMatchObject({ where: { organizationId: 'org-a', enabled: true }, data: { enabled: false } });
      expect(prisma.broadcast.updateMany.mock.calls[0][0]).toMatchObject({
        where: { organizationId: 'org-a', status: { in: ['SCHEDULED', 'SENDING'] } },
        data: { status: 'CANCELLED' },
      });
      expect(prisma.broadcastRecipient.updateMany.mock.calls[0][0]).toMatchObject({
        where: { organizationId: 'org-a', status: 'PENDING' },
        data: { status: 'SKIPPED' },
      });
      expect(prisma.automation.updateMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', status: 'ACTIVE' },
        data: { status: 'PAUSED' },
      });
      expect(prisma.automationTrigger.updateMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', isActive: true },
        data: { isActive: false },
      });
    });

    it('does not delete the workspace when its subscription cannot be cancelled', async () => {
      const { service, prisma, billing, channels } = build(null);
      billing.cancelOrganizationSubscription.mockRejectedValue(new Error('Razorpay down'));

      await expect(service.delete('org-a', 'u1', CONFIRMED)).rejects.toThrow('Razorpay down');

      expect(channels.disconnectAllForOrg).not.toHaveBeenCalled();
      expect(prisma.organization.update).not.toHaveBeenCalled();
    });

    it('only the owner can delete it', async () => {
      const { service, prisma, billing } = build(null);
      prisma.organizationMember.findUnique.mockResolvedValue({
        isActive: true,
        role: UserRole.ADMIN,
        organization: { id: 'org-a', deletedAt: null },
      });

      await expect(service.delete('org-a', 'u1', CONFIRMED)).rejects.toBeInstanceOf(ForbiddenException);
      expect(billing.cancelOrganizationSubscription).not.toHaveBeenCalled();
    });

    it.each([
      ['no name', { password: 'owner-password', confirmName: '' }, BadRequestException],
      ['another name', { password: 'owner-password', confirmName: 'B' }, BadRequestException],
      ['the name in other letters', { password: 'owner-password', confirmName: 'a' }, BadRequestException],
      ['a wrong password', { password: 'guess', confirmName: 'A' }, ForbiddenException],
      ['no password', { password: '', confirmName: 'A' }, ForbiddenException],
    ])('does not delete it with %s, and changes nothing', async (_label, confirm, error) => {
      const { service, prisma, billing, channels } = build(null);

      await expect(service.delete('org-a', 'u1', confirm)).rejects.toBeInstanceOf(error);

      expect(billing.cancelOrganizationSubscription).not.toHaveBeenCalled();
      expect(channels.disconnectAllForOrg).not.toHaveBeenCalled();
      expect(prisma.organization.update).not.toHaveBeenCalled();
    });

    it("checks the password of the owner asking, and takes the name with spaces trimmed", async () => {
      const { service, prisma } = build(null);

      await service.delete('org-a', 'u1', { password: 'owner-password', confirmName: '  A ' });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { password: true } });
      expect(prisma.organization.update).toHaveBeenCalled();
    });
  });

  // The request path and token refresh reject a token whose workspace is not
  // among the user's memberships, so excluding deleted workspaces from that
  // load is what shuts them out.
  describe('authorization queries', () => {
    const membershipsWhere = (call: unknown[]) =>
      (call[0] as { include: { memberships: { where: unknown } } }).include.memberships.where;

    it('the per-request check only loads memberships of live workspaces', async () => {
      const prisma = { user: { findFirst: jest.fn().mockResolvedValue(null) } };
      const redis = {
        isAuthSessionActive: jest.fn().mockResolvedValue(true),
        getSession: jest.fn().mockResolvedValue(null),
      };
      const strategy = new JwtStrategy({ get: () => 'secret' } as never, redis as never, prisma as never);

      await strategy.validate({ sub: 'u1', email: 'u1@example.com', orgId: 'org-a', sid: 's1' }).catch(() => undefined);

      expect(membershipsWhere(prisma.user.findFirst.mock.calls[0] as unknown[])).toEqual(ACTIVE_MEMBERSHIP);
    });

    it('an invite into a deleted workspace cannot be viewed or accepted', async () => {
      const prisma = { teamInvite: { findUnique: jest.fn().mockResolvedValue(null) } };
      const service = new AuthService(
        prisma as never,
        {} as never,
        { get: () => '7d' } as never,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(service.getInviteByToken('tok')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.acceptInvite({ token: 'tok' } as never)).rejects.toBeInstanceOf(NotFoundException);

      for (const call of prisma.teamInvite.findUnique.mock.calls as Array<[{ where: unknown }]>) {
        expect(call[0].where).toMatchObject({ token: 'tok', organization: { deletedAt: null } });
      }
    });

    it('token refresh only loads memberships of live workspaces', async () => {
      const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
      const redis = {
        consumeRefreshToken: jest.fn().mockResolvedValue({ userId: 'u1', orgId: 'org-a', sid: 's1' }),
        clearRefreshRotation: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AuthService(
        prisma as never,
        {} as never,
        { get: () => '7d' } as never,
        {} as never,
        {} as never,
        redis as never,
      );

      await service.rotateRefreshToken('old').catch(() => undefined);

      expect(membershipsWhere(prisma.user.findUnique.mock.calls[0] as unknown[])).toEqual(ACTIVE_MEMBERSHIP);
    });
  });
});
