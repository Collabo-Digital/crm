import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BillingPlan, InviteStatus, OrganizationType, UserRole } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { InvitesService } from './invites.service';
import { MembersService } from './members.service';

/**
 * The stores a Manager or Agent works at: chosen on the invitation, carried
 * onto the membership when it is accepted, and changed later in Team members.
 */

/** The first argument of a mock's nth call. */
const argOf = (fn: { mock: { calls: unknown[][] } }, n = 0) => fn.mock.calls[n][0] as Record<string, unknown>;
describe('store scoping on invitations', () => {
  function build(locationsFound: number) {
    const prisma = {
      organization: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'org', name: 'Shop', type: OrganizationType.ORGANIZATION, billingPlan: BillingPlan.GROWTH }),
        ),
      },
      organizationMember: { findUnique: jest.fn(() => Promise.resolve(null)) },
      teamInvite: {
        findFirst: jest.fn(() => Promise.resolve(null)),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'inv1', status: InviteStatus.PENDING, createdAt: new Date(), ...data }),
        ),
      },
      warehouse: { count: jest.fn(() => Promise.resolve(locationsFound)) },
    };
    const email = { sendTeamInvite: jest.fn(() => Promise.resolve()) };
    const users = { findIdByEmail: jest.fn(() => Promise.resolve(null)) };
    const redis = { allowInviteFromSender: jest.fn(() => Promise.resolve(true)), allowEmailSend: jest.fn(() => Promise.resolve(true)) };
    return { service: new InvitesService(prisma as never, email as never, users as never, redis as never), prisma, email };
  }

  it('saves the chosen stores on the invitation and returns them', async () => {
    const { service, prisma } = build(2);
    const invite = await service.send('org', 'u-admin', {
      email: 'priya@shop.in',
      role: UserRole.MANAGER,
      locationScope: ['s1', 's2', 's1'],
    });
    expect(prisma.warehouse.count).toHaveBeenCalledWith({ where: { organizationId: 'org', id: { in: ['s1', 's2'] } } });
    expect(argOf(prisma.teamInvite.create)).toMatchObject({ data: { role: UserRole.MANAGER, locationScope: ['s1', 's2'] } });
    expect(invite.locationScope).toEqual(['s1', 's2']);
  });

  it('invites with every store when none are chosen', async () => {
    const { service, prisma } = build(0);
    await service.send('org', 'u-admin', { email: 'ravi@shop.in', role: UserRole.AGENT });
    expect(prisma.warehouse.count).not.toHaveBeenCalled();
    expect(argOf(prisma.teamInvite.create)).toMatchObject({ data: { locationScope: [] } });
  });

  it("refuses another workspace's location, and sends no email", async () => {
    const { service, prisma, email } = build(1);
    await expect(
      service.send('org', 'u-admin', { email: 'priya@shop.in', role: UserRole.AGENT, locationScope: ['s1', 'elsewhere'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
    expect(email.sendTeamInvite).not.toHaveBeenCalled();
  });

  it('refuses stores for a role they do not apply to', async () => {
    const { service, prisma } = build(1);
    await expect(
      service.send('org', 'u-admin', { email: 'boss@shop.in', role: UserRole.ADMIN, locationScope: ['s1'] }),
    ).rejects.toThrow('Only managers and agents can be limited to stores.');
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
  });
});

describe('accepting an invitation with stores', () => {
  it('gives the membership the stores the invitation names, joining or re-joining', async () => {
    const prisma = {
      teamInvite: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'inv1',
            token: 'tok',
            email: 'priya@shop.in',
            name: null,
            status: InviteStatus.PENDING,
            role: UserRole.MANAGER,
            vendorScope: null,
            permissions: null,
            locationScope: ['s1', 's2'],
            organizationId: 'org',
            invitedBy: 'u-admin',
            expiresAt: new Date(Date.now() + 3600_000),
            organization: { id: 'org', name: 'Shop', slug: 'shop', logo: null, type: 'ORGANIZATION' },
          }),
        ),
        update: jest.fn(() => Promise.resolve(undefined)),
      },
      organizationMember: {
        findUnique: jest.fn(() => Promise.resolve({ role: UserRole.OWNER, isActive: true, user: { deletedAt: null } })),
        upsert: jest.fn(() => Promise.resolve(undefined)),
      },
      user: { update: jest.fn(() => Promise.resolve(undefined)) },
      refreshToken: { create: jest.fn(() => Promise.resolve(undefined)) },
    };
    const users = {
      findByEmail: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({ id: 'u-new', email: 'priya@shop.in', firstName: 'Priya', lastName: 'S' })),
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

    await service.acceptInvite({ token: 'tok', firstName: 'Priya', lastName: 'S', password: 'long-enough-1' });

    expect(argOf(prisma.organizationMember.upsert)).toMatchObject({
      create: { role: UserRole.MANAGER, locationScope: ['s1', 's2'] },
      update: { role: UserRole.MANAGER, locationScope: ['s1', 's2'] },
    });
  });
});

describe('MembersService.updateLocationScope', () => {
  function build(role: UserRole | null, locationsFound = 0) {
    const prisma = {
      organizationMember: {
        findFirst: jest.fn(() => Promise.resolve(role ? { id: 'm1', role } : null)),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'm1', role, ...data })),
      },
      organization: { findUnique: jest.fn(() => Promise.resolve({ billingPlan: BillingPlan.ADVANCE })) },
      warehouse: { count: jest.fn(() => Promise.resolve(locationsFound)) },
    };
    return { service: new MembersService(prisma as never, {} as never, {} as never, {} as never), prisma };
  }

  it("saves a Manager's stores", async () => {
    const { service, prisma } = build(UserRole.MANAGER, 1);
    await expect(service.updateLocationScope('org', 'm1', ['s1'])).resolves.toMatchObject({ locationScope: ['s1'] });
    expect(prisma.organizationMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm1', organizationId: 'org', isActive: true } }),
    );
    expect(prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { locationScope: ['s1'] },
      select: { id: true, role: true, locationScope: true },
    });
  });

  it('clears the stores back to every location', async () => {
    const { service, prisma } = build(UserRole.AGENT);
    await service.updateLocationScope('org', 'm1', []);
    expect(prisma.organizationMember.update).toHaveBeenCalledWith(expect.objectContaining({ data: { locationScope: [] } }));
  });

  it('refuses the owner and admins, who always work everywhere', async () => {
    for (const role of [UserRole.OWNER, UserRole.ADMIN]) {
      const { service, prisma } = build(role, 1);
      await expect(service.updateLocationScope('org', 'm1', ['s1'])).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.organizationMember.update).not.toHaveBeenCalled();
    }
  });

  it("refuses a location that is not the workspace's", async () => {
    const { service, prisma } = build(UserRole.AGENT, 0);
    await expect(service.updateLocationScope('org', 'm1', ['elsewhere'])).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.organizationMember.update).not.toHaveBeenCalled();
  });

  it('refuses a member who is not in the workspace', async () => {
    const { service } = build(null);
    await expect(service.updateLocationScope('org', 'gone', ['s1'])).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MembersService.findAll', () => {
  it("shows the team managers each member's stores", async () => {
    const prisma = {
      organizationMember: {
        findMany: jest.fn(() =>
          Promise.resolve([
            {
              id: 'm1', userId: 'u1', role: UserRole.AGENT, permissions: null, locationScope: ['s1'], joinedAt: new Date(),
              user: { id: 'u1', email: 'a@shop.in', firstName: 'A', lastName: 'B', avatarUrl: null, lastLoginAt: null },
            },
          ]),
        ),
      },
    };
    const service = new MembersService(prisma as never, {} as never, {} as never, {} as never);
    const [row] = await service.findAll('org', { userId: 'u-admin', role: UserRole.ADMIN });
    expect(row).toMatchObject({ id: 'm1', locationScope: ['s1'] });
  });
});
