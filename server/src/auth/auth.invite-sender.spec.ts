import { BadRequestException } from '@nestjs/common';
import { InviteStatus, UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { InvitesService } from '../organization/invites.service';

/**
 * A pending invitation grants its sender's authority, so it stops working
 * when the sender loses it. The case it closes: an admin, before being
 * removed or demoted, invites a second address of their own as ADMIN and
 * uses it afterwards to come back in.
 */
describe('AuthService — an invitation needs a sender who may still invite', () => {
  type Inviter = { role: UserRole; isActive: boolean; user: { deletedAt: Date | null } } | null;

  function build(inviter: Inviter) {
    const prisma = {
      teamInvite: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'inv1',
            token: 'tok',
            email: 'second-address@mail.test',
            name: null,
            status: InviteStatus.PENDING,
            role: UserRole.ADMIN,
            vendorScope: null,
            permissions: null,
            organizationId: 'org',
            invitedBy: 'u-admin',
            expiresAt: new Date(Date.now() + 3600_000),
            organization: { id: 'org', name: 'Shop', slug: 'shop', logo: null, type: 'ORGANIZATION' },
          }),
        ),
        update: jest.fn(() => Promise.resolve(undefined)),
      },
      organizationMember: {
        findUnique: jest.fn(() => Promise.resolve(inviter)),
        upsert: jest.fn(() => Promise.resolve(undefined)),
      },
      user: { update: jest.fn(() => Promise.resolve(undefined)) },
      refreshToken: { create: jest.fn(() => Promise.resolve(undefined)) },
    };
    const users = {
      findByEmail: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({ id: 'u-alt', email: 'second-address@mail.test', firstName: 'A', lastName: 'L' })),
    };
    const redis = {
      deleteSession: jest.fn(() => Promise.resolve()),
      setAuthSession: jest.fn(() => Promise.resolve()),
      setRefreshToken: jest.fn(() => Promise.resolve()),
      trackUserToken: jest.fn(() => Promise.resolve()),
    };
    const service = new AuthService(
      prisma as never,
      { sign: () => 'access' } as never,
      { get: () => undefined } as never,
      users as never,
      {} as never,
      redis as never,
    );
    return { service, prisma, users };
  }

  const accept = (service: AuthService) =>
    service.acceptInvite({ token: 'tok', firstName: 'A', lastName: 'L', password: 'long-enough-1' });

  it.each([
    ['removed', { role: UserRole.ADMIN, isActive: false, user: { deletedAt: null } }],
    ['demoted', { role: UserRole.MANAGER, isActive: true, user: { deletedAt: null } }],
    ['deactivated by support', { role: UserRole.ADMIN, isActive: true, user: { deletedAt: new Date() } }],
    ['gone from the workspace altogether', null],
  ])('refuses an invitation whose sender was %s, before creating an account or a membership', async (_case, inviter) => {
    const { service, prisma, users } = build(inviter as Inviter);

    await expect(accept(service)).rejects.toThrow(BadRequestException);
    await expect(accept(service)).rejects.toThrow('no longer valid');

    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: 'org', userId: 'u-admin' } },
      select: { role: true, isActive: true, user: { select: { deletedAt: true } } },
    });
    expect(users.create).not.toHaveBeenCalled();
    expect(prisma.organizationMember.upsert).not.toHaveBeenCalled();
    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
  });

  it('tells the invitee so on the invitation page too', async () => {
    const { service } = build({ role: UserRole.ADMIN, isActive: false, user: { deletedAt: null } });
    await expect(service.getInviteByToken('tok')).rejects.toThrow('no longer valid');
  });

  it.each([UserRole.OWNER, UserRole.ADMIN])('accepts it while the sender is still an active %s', async (role) => {
    const { service, prisma } = build({ role, isActive: true, user: { deletedAt: null } });

    await expect(accept(service)).resolves.toMatchObject({ role: UserRole.ADMIN, organization: { id: 'org' } });
    expect(prisma.organizationMember.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('InvitesService.resend — the admin who re-sends takes the invitation over', () => {
  it('records the re-sender as its sender', async () => {
    const prisma = {
      teamInvite: {
        findFirst: jest.fn(() =>
          Promise.resolve({ id: 'inv1', email: 'a@b.c', status: InviteStatus.PENDING, invitedBy: 'u-removed-admin', organization: { name: 'Shop' } }),
        ),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'inv1', email: 'a@b.c', name: null, role: UserRole.AGENT, vendorScope: null, permissions: null,
            status: InviteStatus.PENDING, expiresAt: new Date(), createdAt: new Date(), token: 't2', ...data,
          }),
        ),
      },
    };
    const email = { sendTeamInvite: jest.fn(() => Promise.resolve()) };
    const redis = { allowInviteFromSender: jest.fn(() => Promise.resolve(true)), allowEmailSend: jest.fn(() => Promise.resolve(true)) };
    const service = new InvitesService(prisma as never, email as never, {} as never, redis as never);

    await service.resend('org', 'inv1', 'u-current-admin');

    expect(prisma.teamInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ invitedBy: 'u-current-admin', status: InviteStatus.PENDING }) }),
    );
  });
});
