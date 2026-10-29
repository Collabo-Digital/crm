import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConversationStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { UserService } from './user.service';

/** The account's password, hashed cheaply for tests. */
const PASSWORD_HASH = bcrypt.hashSync('account-password', 4);

describe('UserService — account lookup and deletion', () => {
  function build() {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new', ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'u1', ...data })),
      },
      organizationMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{ organizationId: 'org-a' }, { organizationId: 'org-b' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      conversation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'c1', organizationId: 'org-a' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inboxTeamMember: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
    const channels = { disconnectOwnedBy: jest.fn().mockResolvedValue(undefined) };
    return { service: new UserService(prisma as never, channels as never), prisma, channels };
  }

  describe('findIdByEmail', () => {
    it('finds an account stored with capitals from any casing', async () => {
      const { service, prisma } = build();
      prisma.$queryRaw.mockResolvedValue([{ id: 'u-old' }]);

      await expect(service.findIdByEmail(' Priya@SHOP.com ')).resolves.toBe('u-old');
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'priya@shop.com' }, select: { id: true } });
      // Compared with lower() and a bound value, never a LIKE pattern.
      const [sql, value] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
      expect(sql.join('?')).toContain('lower(email) = ?');
      expect(value).toBe('priya@shop.com');
    });

    it('prefers the exact lower-case account', async () => {
      const { service, prisma } = build();
      prisma.user.findUnique.mockResolvedValue({ id: 'u-new' });

      await expect(service.findIdByEmail('priya@shop.com')).resolves.toBe('u-new');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('stores the address lower-cased', async () => {
      const { service, prisma } = build();

      await service.create({ email: 'Priya@Shop.com', password: 'password-1', firstName: 'P', lastName: 'S' });

      expect(prisma.user.create.mock.calls[0][0].data.email).toBe('priya@shop.com');
    });

    it('refuses an address an older account holds in another casing', async () => {
      const { service, prisma } = build();
      prisma.$queryRaw.mockResolvedValue([{ id: 'u-old' }]);

      await expect(
        service.create({ email: 'priya@shop.com', password: 'password-1', firstName: 'P', lastName: 'S' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('softDelete', () => {
    function withPassword() {
      const built = build();
      built.prisma.user.findUnique.mockResolvedValue({ password: PASSWORD_HASH });
      return built;
    }

    it.each([
      ['a wrong password', 'guess'],
      ['no password', ''],
    ])('does not close the account with %s, and changes nothing', async (_label, password) => {
      const { service, prisma } = withPassword();

      await expect(service.softDelete('u1', password)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { password: true } });
      expect(prisma.organizationMember.updateMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('checks the password before saying which workspace the account owns', async () => {
      const { service, prisma } = withPassword();
      prisma.organizationMember.findFirst.mockResolvedValue({ organization: { name: 'Acme' } });

      await expect(service.softDelete('u1', 'guess')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
    });

    it('refuses while the account owns a live workspace', async () => {
      const { service, prisma } = withPassword();
      prisma.organizationMember.findFirst.mockResolvedValue({ organization: { name: 'Acme' } });

      await expect(service.softDelete('u1', 'account-password')).rejects.toThrow('You own the workspace "Acme"');
      expect(prisma.organizationMember.findFirst.mock.calls[0][0].where).toMatchObject({
        userId: 'u1',
        role: UserRole.OWNER,
        isActive: true,
        organization: { deletedAt: null },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('ends the memberships, releases their open chats and frees the address', async () => {
      const { service, prisma } = withPassword();

      await service.softDelete('u1', 'account-password');

      expect(prisma.organizationMember.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', isActive: true },
        data: { isActive: false },
      });
      expect(prisma.conversation.findMany.mock.calls[0][0].where).toEqual({
        organizationId: { in: ['org-a', 'org-b'] },
        assignedUserId: 'u1',
        status: { not: ConversationStatus.CLOSED },
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['c1'] }, assignedUserId: 'u1' },
        data: { assignedUserId: null },
      });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(data.email).toBe('deleted+u1@deleted.invalid');
    });

    it("disconnects the Instagram an influencer connected in the workspaces they leave, before closing the account", async () => {
      const { service, prisma, channels } = build();
      prisma.organizationMember.findMany.mockImplementation(({ where }: { where: { role?: UserRole } }) =>
        Promise.resolve(where.role === UserRole.INFLUENCER ? [{ organizationId: 'org-brand' }] : [{ organizationId: 'org-a' }, { organizationId: 'org-brand' }]),
      );

      await service.softDelete('u1');

      expect(prisma.organizationMember.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', isActive: true, role: UserRole.INFLUENCER },
        select: { organizationId: true },
      });
      expect(channels.disconnectOwnedBy).toHaveBeenCalledWith(['org-brand'], 'u1');
      expect(channels.disconnectOwnedBy.mock.invocationCallOrder[0]).toBeLessThan(prisma.organizationMember.updateMany.mock.invocationCallOrder[0]);
    });

    it('leaves the account open when those channels could not be disconnected', async () => {
      const { service, prisma, channels } = build();
      channels.disconnectOwnedBy.mockRejectedValue(new Error('database busy'));

      await expect(service.softDelete('u1')).rejects.toThrow('database busy');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
