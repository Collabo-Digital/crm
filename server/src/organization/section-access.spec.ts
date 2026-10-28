import { BadRequestException } from '@nestjs/common';
import { InviteStatus, OrganizationType, UserRole } from '@prisma/client';
import { InvitesService } from './invites.service';
import { MembersService } from './members.service';
import { canListOrders, resolveSections } from '../auth/permissions';

/** Section access on the invite and member paths (see auth/permissions.ts). */
describe('section access — invites', () => {
  function build() {
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ id: 'org', name: 'Org', type: OrganizationType.ORGANIZATION }),
      },
      teamInvite: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'inv', status: InviteStatus.PENDING, vendorScope: null, ...data }),
        ),
      },
    };
    const email = { sendTeamInvite: jest.fn().mockResolvedValue(undefined) };
    const users = { findIdByEmail: jest.fn().mockResolvedValue(null) };
    return { service: new InvitesService(prisma as never, email as never, users as never), prisma, email };
  }

  it('stores the chosen sections on an AGENT invite', async () => {
    const { service, prisma } = build();
    const result = await service.send('org', 'u1', {
      email: 'a@b.c', role: UserRole.AGENT, grants: ['section.orders', 'section.customers'],
    });
    expect(prisma.teamInvite.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ permissions: { grants: ['section.orders', 'section.customers'] } }),
    });
    expect(result.permissions).toEqual(['section.orders', 'section.customers']);
  });

  it('refuses a grant list that names no section, before anything is sent', async () => {
    const { service, prisma, email } = build();
    await expect(
      service.send('org', 'u1', { email: 'a@b.c', role: UserRole.VIEWER, grants: ['inventory.view'] }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.teamInvite.create).not.toHaveBeenCalled();
    expect(email.sendTeamInvite).not.toHaveBeenCalled();
  });

  it('ignores grants for roles that are not section-scoped, and when omitted', async () => {
    const { service, prisma } = build();
    await service.send('org', 'u1', { email: 'a@b.c', role: UserRole.MANAGER, grants: ['section.orders'] });
    await service.send('org', 'u1', { email: 'a@b.c', role: UserRole.AGENT });
    for (const [call] of prisma.teamInvite.create.mock.calls) {
      expect(call.data).not.toHaveProperty('permissions');
    }
  });
});

describe('section access — members', () => {
  function build(role: UserRole) {
    const prisma = {
      organizationMember: {
        findFirst: jest.fn().mockResolvedValue({ id: 'm1', userId: 'u2', role }),
        update: jest.fn().mockResolvedValue({ id: 'm1' }),
      },
    };
    const redis = { deleteSession: jest.fn().mockResolvedValue(undefined) };
    return { service: new MembersService(prisma as never, redis as never, {} as never, {} as never), prisma, redis };
  }

  it('replaces the grants and drops the cached session', async () => {
    const { service, prisma, redis } = build(UserRole.AGENT);
    await service.updatePermissions('org', 'm1', ['section.orders', 'inventory.view']);
    expect(prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { permissions: { grants: ['section.orders', 'inventory.view'] } },
    });
    expect(redis.deleteSession).toHaveBeenCalledWith('u2');
  });

  it('refuses to leave an AGENT with no section (that would mean full access)', async () => {
    const { service, prisma } = build(UserRole.AGENT);
    await expect(service.updatePermissions('org', 'm1', ['inventory.view'])).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.organizationMember.update).not.toHaveBeenCalled();
  });

  it('does not require sections for a MANAGER', async () => {
    const { service, prisma } = build(UserRole.MANAGER);
    await service.updatePermissions('org', 'm1', ['inventory.view']);
    expect(prisma.organizationMember.update).toHaveBeenCalled();
  });
});

describe('resolveSections / canListOrders', () => {
  it('resolves by role first, then by grants', () => {
    expect(resolveSections(UserRole.ADMIN, ['section.orders'])).toBe('all');
    expect(resolveSections(UserRole.VENDOR, [])).toBe('all');
    expect(resolveSections(UserRole.AGENT, ['inventory.view'])).toBe('all');
    expect(resolveSections(UserRole.AGENT, ['section.orders'])).toEqual(new Set(['section.orders']));
  });

  it('serves the order list to other sections only through their own filter', () => {
    const customers = ['section.customers'];
    expect(canListOrders(UserRole.AGENT, customers, {})).toBe(false);
    expect(canListOrders(UserRole.AGENT, customers, { productId: 'p1' })).toBe(false);
    expect(canListOrders(UserRole.AGENT, customers, { customerId: 'c1' })).toBe(true);
    expect(canListOrders(UserRole.AGENT, ['section.products'], { productId: 'p1' })).toBe(true);
    expect(canListOrders(UserRole.AGENT, ['section.orders'], {})).toBe(true);
    expect(canListOrders(UserRole.AGENT, [], {})).toBe(true);
    expect(canListOrders(UserRole.MANAGER, customers, {})).toBe(true);
  });
});
