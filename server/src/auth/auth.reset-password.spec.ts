import { NotFoundException } from '@nestjs/common';
import { AuthService } from './auth.service';

interface TokenRow {
  id: string;
  userId: string;
  token: string;
  usedAt: Date | null;
  expiresAt: Date;
}

interface TokenWhere {
  id?: string;
  userId?: string;
  token?: string;
  usedAt?: null;
  expiresAt?: { gt: Date };
}

/**
 * A reset link is single use. The lookup-then-update used to leave a window
 * (password hashing sits between them) in which two requests with the same
 * link both changed the password, and other links for the account stayed live.
 */
describe('AuthService.resetPassword — a reset link works exactly once', () => {
  const hour = 3600000;

  function build(opts: { failPasswordUpdate?: boolean } = {}) {
    // A tiny in-memory stand-in for the two tables, with all-or-nothing
    // transactions, so the conditional claim is exercised for real.
    let tokens: TokenRow[] = [
      { id: 't1', userId: 'u1', token: 'link-1', usedAt: null, expiresAt: new Date(Date.now() + hour) },
      { id: 't2', userId: 'u1', token: 'link-older', usedAt: null, expiresAt: new Date(Date.now() + hour) },
      { id: 't3', userId: 'u2', token: 'link-other-user', usedAt: null, expiresAt: new Date(Date.now() + hour) },
    ];
    const passwords: string[] = [];

    const matches = (row: TokenRow, where: TokenWhere) =>
      (where.id === undefined || row.id === where.id) &&
      (where.userId === undefined || row.userId === where.userId) &&
      (where.token === undefined || row.token === where.token) &&
      (where.usedAt === undefined || row.usedAt === null) &&
      (where.expiresAt === undefined || row.expiresAt > where.expiresAt.gt);

    const passwordResetToken = {
      findFirst: jest.fn(({ where }: { where: TokenWhere }) =>
        Promise.resolve(tokens.find((row) => matches(row, where)) ?? null),
      ),
      updateMany: jest.fn(({ where, data }: { where: TokenWhere; data: { usedAt: Date } }) => {
        const hit = tokens.filter((row) => matches(row, where));
        hit.forEach((row) => (row.usedAt = data.usedAt));
        return Promise.resolve({ count: hit.length });
      }),
    };
    const user = {
      update: jest.fn(({ data }: { data: { password: string } }) => {
        if (opts.failPasswordUpdate) return Promise.reject(new Error('db down'));
        passwords.push(data.password);
        return Promise.resolve();
      }),
    };
    const prisma = {
      passwordResetToken,
      user,
      refreshToken: { updateMany: jest.fn().mockResolvedValue(undefined) },
      $transaction: jest.fn(async (run: (tx: unknown) => Promise<void>) => {
        const snapshot = tokens.map((row) => ({ ...row }));
        const written = passwords.length;
        try {
          await run({ passwordResetToken, user });
        } catch (err) {
          tokens = snapshot;
          passwords.length = written;
          throw err;
        }
      }),
    };
    const redis = {
      deleteAllUserTokens: jest.fn().mockResolvedValue(undefined),
      deleteAllAuthSessions: jest.fn().mockResolvedValue(undefined),
      deleteSession: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AuthService(
      prisma as never,
      {} as never,
      { get: jest.fn().mockReturnValue('7d') } as never,
      {} as never,
      {} as never,
      redis as never,
    );
    return { service, redis, prisma, passwords, usedAt: (id: string) => tokens.find((row) => row.id === id)?.usedAt };
  }

  it('changes the password, burns the link and revokes every session', async () => {
    const { service, redis, passwords, usedAt } = build();

    await service.resetPassword({ token: 'link-1', newPassword: 'New-password-1' });

    expect(passwords).toHaveLength(1);
    expect(usedAt('t1')).toBeInstanceOf(Date);
    expect(redis.deleteAllAuthSessions).toHaveBeenCalledWith('u1', undefined);
  });

  it('lets only one of two concurrent requests with the same link change the password', async () => {
    const { service, passwords } = build();

    const outcomes = await Promise.allSettled([
      service.resetPassword({ token: 'link-1', newPassword: 'Owner-password-1' }),
      service.resetPassword({ token: 'link-1', newPassword: 'Attacker-password-1' }),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(NotFoundException);
    expect(passwords).toHaveLength(1);
  });

  it('lets only one of two concurrent requests with different links for one account win', async () => {
    const { service, passwords, usedAt } = build();

    const outcomes = await Promise.allSettled([
      service.resetPassword({ token: 'link-1', newPassword: 'Owner-password-1' }),
      service.resetPassword({ token: 'link-older', newPassword: 'Attacker-password-1' }),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(passwords).toHaveLength(1);
    expect(usedAt('t1')).toBeInstanceOf(Date);
    expect(usedAt('t2')).toBeInstanceOf(Date);
  });

  it('locks the user row before any link, so two resets for one account cannot deadlock', async () => {
    const { service, prisma } = build();

    await service.resetPassword({ token: 'link-1', newPassword: 'New-password-1' });

    const userWrite = prisma.user.update.mock.invocationCallOrder[0];
    const firstLinkWrite = prisma.passwordResetToken.updateMany.mock.invocationCallOrder[0];
    expect(userWrite).toBeLessThan(firstLinkWrite);
  });

  it("invalidates the account's other outstanding links, and nobody else's", async () => {
    const { service, usedAt } = build();

    await service.resetPassword({ token: 'link-1', newPassword: 'New-password-1' });

    expect(usedAt('t2')).toBeInstanceOf(Date);
    expect(usedAt('t3')).toBeNull();
    await expect(service.resetPassword({ token: 'link-older', newPassword: 'Again-1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('leaves the link usable when the password could not be saved', async () => {
    const { service, redis, usedAt } = build({ failPasswordUpdate: true });

    await expect(service.resetPassword({ token: 'link-1', newPassword: 'New-password-1' })).rejects.toThrow('db down');

    expect(usedAt('t1')).toBeNull();
    expect(usedAt('t2')).toBeNull();
    expect(redis.deleteAllAuthSessions).not.toHaveBeenCalled();
  });

  it('rejects an expired link', async () => {
    const { service, passwords } = build();
    jest.useFakeTimers({ now: Date.now() + 2 * hour, doNotFake: ['nextTick', 'setImmediate'] });

    try {
      await expect(service.resetPassword({ token: 'link-1', newPassword: 'New-password-1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    } finally {
      jest.useRealTimers();
    }
    expect(passwords).toHaveLength(0);
  });
});
