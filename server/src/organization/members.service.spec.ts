import { BadRequestException } from '@nestjs/common';
import { ConversationStatus, UserRole } from '@prisma/client';
import { MembersService } from './members.service';

describe('MembersService', () => {
  function build(role: UserRole = UserRole.AGENT) {
    const prisma = {
      organizationMember: {
        findFirst: jest.fn().mockResolvedValue({ id: 'm1', userId: 'u2', role }),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'm1', ...data })),
      },
      product: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'c1', organizationId: 'org' },
          { id: 'c2', organizationId: 'org' },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      inboxTeamMember: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
    const redis = { deleteSession: jest.fn().mockResolvedValue(undefined) };
    const events = { publish: jest.fn() };
    return { service: new MembersService(prisma as never, redis as never, events as never), prisma, redis, events };
  }

  describe('updateRole', () => {
    it('refuses VENDOR without a vendor, which would lock the member out of every screen', async () => {
      const { service, prisma } = build();
      await expect(service.updateRole('org', 'm1', UserRole.VENDOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.organizationMember.update).not.toHaveBeenCalled();
    });

    it('refuses a vendor the organization has no products for', async () => {
      const { service, prisma } = build();
      await expect(service.updateRole('org', 'm1', UserRole.VENDOR, 'Nobody')).rejects.toThrow('No products found');
      expect(prisma.organizationMember.update).not.toHaveBeenCalled();
    });

    it('stores the vendor with the VENDOR role', async () => {
      const { service, prisma } = build();
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
      await service.updateRole('org', 'm1', UserRole.VENDOR, ' Acme ');
      expect(prisma.product.findFirst.mock.calls[0][0].where).toMatchObject({ organizationId: 'org', OR: [{ vendorKey: 'Acme' }, { vendor: 'Acme' }] });
      expect(prisma.organizationMember.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: UserRole.VENDOR, vendorScope: 'Acme' } });
    });

    it('clears the vendor when the member moves to another role', async () => {
      const { service, prisma } = build(UserRole.VENDOR);
      await service.updateRole('org', 'm1', UserRole.AGENT);
      expect(prisma.organizationMember.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { role: UserRole.AGENT, vendorScope: null } });
    });

    it('refuses INFLUENCER, which only an influencer invitation grants', async () => {
      const { service, prisma } = build();
      await expect(service.updateRole('org', 'm1', UserRole.INFLUENCER)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.organizationMember.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it("puts the member's open and snoozed conversations back in the queue and takes them off inbox teams", async () => {
      const { service, prisma, redis, events } = build();

      await service.remove('org', 'm1');

      expect(prisma.organizationMember.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { isActive: false } });
      expect(prisma.conversation.findMany.mock.calls[0][0].where).toEqual({
        organizationId: { in: ['org'] },
        assignedUserId: 'u2',
        status: { not: ConversationStatus.CLOSED },
      });
      // Only the assignee is cleared: the team stays so its queue picks the chat up.
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['c1', 'c2'] }, assignedUserId: 'u2' },
        data: { assignedUserId: null },
      });
      expect(prisma.inboxTeamMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u2', team: { organizationId: { in: ['org'] } } } });
      expect(redis.deleteSession).toHaveBeenCalledWith('u2');
      expect(events.publish.mock.calls.map((c) => c[1].conversationId)).toEqual(['c1', 'c2']);
    });
  });
});
