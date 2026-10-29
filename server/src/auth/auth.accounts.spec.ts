import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { UserController } from '../user/user.controller';

/**
 * Sign-in, password reset and invitation acceptance across address casing,
 * and the limits on login attempts and account emails.
 */
describe('AuthService — accounts', () => {
  const password = 'Correct-horse-1';
  let hash: string;
  beforeAll(async () => {
    hash = await bcrypt.hash(password, 4);
  });

  function build() {
    const account = {
      id: 'u1',
      email: 'Priya@Shop.com',
      password: hash,
      deletedAt: null,
      emailVerified: true,
      twoFactorEnabled: false,
      isSuperAdmin: false,
      firstName: 'Priya',
      lastName: 'S',
      avatarUrl: null,
      memberships: [],
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(account),
        update: jest.fn().mockResolvedValue(account),
      },
      passwordResetToken: { create: jest.fn().mockResolvedValue(undefined) },
      refreshToken: { create: jest.fn().mockResolvedValue(undefined) },
      teamInvite: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv1',
          token: 'tok',
          email: 'priya@shop.com',
          status: 'PENDING',
          role: 'AGENT',
          vendorScope: null,
          permissions: null,
          organizationId: 'org',
          invitedBy: 'u-owner',
          expiresAt: new Date(Date.now() + 3600_000),
          organization: { id: 'org', name: 'Shop', slug: 'shop', type: 'ORGANIZATION' },
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      organizationMember: {
        upsert: jest.fn().mockResolvedValue(undefined),
        // The sender of the invitation, still the owner.
        findUnique: jest.fn().mockResolvedValue({ role: 'OWNER', isActive: true, user: { deletedAt: null } }),
      },
    };
    const users = {
      findIdByEmail: jest.fn().mockResolvedValue('u1'),
      findByEmail: jest.fn().mockResolvedValue(account),
      regenerateVerifyCode: jest.fn().mockResolvedValue({ ...account, emailVerifyCode: '123456' }),
    };
    const email = {
      sendPasswordResetLink: jest.fn().mockResolvedValue(undefined),
      sendVerificationCode: jest.fn().mockResolvedValue(undefined),
    };
    const redis = {
      countLoginAttempt: jest.fn().mockResolvedValue(false),
      resetLoginAttempts: jest.fn().mockResolvedValue(undefined),
      allowEmailSend: jest.fn().mockResolvedValue(true),
      setAuthSession: jest.fn().mockResolvedValue(undefined),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      trackUserToken: jest.fn().mockResolvedValue(undefined),
      sessionRevision: jest.fn().mockResolvedValue('rev-1'),
      setSession: jest.fn().mockResolvedValue(true),
      deleteSession: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AuthService(
      prisma as never,
      { sign: jest.fn().mockReturnValue('access') } as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      users as never,
      email as never,
      redis as never,
    );
    return { service, prisma, users, email, redis, account };
  }

  describe('login', () => {
    it('signs in an account stored with capitals when the address is typed in lower case', async () => {
      const { service, users, redis } = build();

      await expect(service.login({ email: 'priya@shop.com', password }, 'ua', '1.2.3.4')).resolves.toMatchObject({
        user: { id: 'u1' },
      });
      expect(users.findIdByEmail).toHaveBeenCalledWith('priya@shop.com');
      expect(redis.resetLoginAttempts).toHaveBeenCalledWith('priya@shop.com', '1.2.3.4');
    });

    it('counts the attempt before checking the password, and refuses one over the limit without checking it', async () => {
      const { service, users, redis } = build();
      redis.countLoginAttempt.mockResolvedValue(true);

      await expect(service.login({ email: 'priya@shop.com', password }, 'ua', '1.2.3.4')).rejects.toThrow('Too many failed login attempts');
      expect(redis.countLoginAttempt).toHaveBeenCalledWith('priya@shop.com', '1.2.3.4');
      expect(users.findIdByEmail).not.toHaveBeenCalled();
    });

    it('does not clear the count on a wrong password', async () => {
      const { service, redis } = build();

      await expect(service.login({ email: 'priya@shop.com', password: 'wrong-password' }, 'ua', '1.2.3.4')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(redis.resetLoginAttempts).not.toHaveBeenCalled();
    });

    // No second-factor check exists yet; accepting any code would make the flag meaningless.
    it.each([undefined, '123456'])('refuses an account with two-factor turned on (code %s) and issues no session', async (totpCode) => {
      const { service, redis, account } = build();
      account.twoFactorEnabled = true;

      const attempt = service.login({ email: 'priya@shop.com', password, totpCode }, 'ua', '1.2.3.4');

      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toThrow('Two-factor sign-in is not available yet');
      expect(redis.setAuthSession).not.toHaveBeenCalled();
    });
  });

  describe('forgotPassword', () => {
    it("sends the link to the account's own address", async () => {
      const { service, email } = build();

      await service.forgotPassword('priya@shop.com');

      expect(email.sendPasswordResetLink).toHaveBeenCalledWith('Priya@Shop.com', expect.any(String));
    });

    it('stores only a hash of the emailed token', async () => {
      const { service, email, prisma } = build();

      await service.forgotPassword('priya@shop.com');

      const [, emailed] = email.sendPasswordResetLink.mock.calls[0] as [string, string];
      const [{ data }] = prisma.passwordResetToken.create.mock.calls[0] as [{ data: { token: string } }];
      expect(data.token).toBe('sha256:' + createHash('sha256').update(emailed).digest('hex'));
    });

    it('sends nothing over the per-address limit, and answers the same', async () => {
      const { service, email, users, redis } = build();
      redis.allowEmailSend.mockResolvedValue(false);

      const answer = await service.forgotPassword('priya@shop.com');

      expect(answer.message).toMatch(/If an account exists/);
      expect(redis.allowEmailSend).toHaveBeenCalledWith('password-reset', 'priya@shop.com');
      expect(users.findByEmail).not.toHaveBeenCalled();
      expect(email.sendPasswordResetLink).not.toHaveBeenCalled();
    });
  });

  it('does not send a new verification code over the limit', async () => {
    const { service, users, email, redis } = build();
    redis.allowEmailSend.mockResolvedValue(false);

    await service.resendVerification('u1');

    expect(users.regenerateVerifyCode).not.toHaveBeenCalled();
    expect(email.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('refuses to sign in a two-factor account through an invitation, even with its password', async () => {
    const { service, prisma, redis, account } = build();
    account.twoFactorEnabled = true;

    await expect(service.acceptInvite({ token: 'tok', password })).rejects.toThrow('Two-factor sign-in is not available yet');
    expect(prisma.organizationMember.upsert).not.toHaveBeenCalled();
    expect(redis.setAuthSession).not.toHaveBeenCalled();
  });

  it('accepts an invitation to the lower-cased address while signed in as the capitalised account', async () => {
    const { service, prisma } = build();

    await expect(service.acceptInvite({ token: 'tok' }, 'u1')).resolves.toMatchObject({ user: { id: 'u1' } });
    expect(prisma.organizationMember.upsert.mock.calls[0][0].where).toEqual({
      organizationId_userId: { organizationId: 'org', userId: 'u1' },
    });
  });
});

describe('UserController.changePassword', () => {
  it('keeps the session that changed the password signed in', async () => {
    const users = { changePassword: jest.fn().mockResolvedValue(undefined) };
    const auth = { revokeAllUserTokens: jest.fn().mockResolvedValue(undefined) };
    const controller = new UserController(users as never, auth as never);

    await controller.changePassword({ sub: 'u1', email: 'a@b.c', sid: 's-mine' }, { currentPassword: 'old-password', newPassword: 'new-password' });

    expect(auth.revokeAllUserTokens).toHaveBeenCalledWith('u1', 's-mine');
  });
});
