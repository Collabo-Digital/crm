import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import RedisMock from 'ioredis-mock';
import { RedisService } from '../redis/redis.service';
import { VERIFY_CODE_LIMIT } from '../redis/redis.constants';
import { AuthService } from './auth.service';

/**
 * The six-digit email verification code is guessable when tries are only
 * limited per IP address, so they are counted per account as well: after
 * VERIFY_CODE_LIMIT.MAX_ATTEMPTS the code is spent, and only a new one can
 * verify the address.
 */
describe('AuthService — email verification code tries', () => {
  async function build() {
    const redis = new RedisService({ get: () => 'redis://localhost:6379' } as never);
    const client = new RedisMock();
    (redis as unknown as { client: unknown }).client = client;
    await client.flushall();

    let code = '123456';
    const account = { id: 'u1', email: 'new@shop.com', firstName: 'N', lastName: 'S', avatarUrl: null };
    const users = {
      verifyEmail: jest.fn((_id: string, tried: string) =>
        tried === code ? Promise.resolve(account) : Promise.reject(new NotFoundException('Invalid or expired verification token')),
      ),
      regenerateVerifyCode: jest.fn(() => {
        code = '654321';
        return Promise.resolve({ ...account, emailVerifyCode: code });
      }),
      findByIdWithMemberships: jest.fn(() => Promise.resolve({ memberships: [] })),
    };
    const prisma = {
      user: {
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        findUniqueOrThrow: jest.fn(() => Promise.resolve({ id: 'u1', email: 'new@shop.com', isSuperAdmin: false })),
      },
      refreshToken: { create: jest.fn(() => Promise.resolve(undefined)) },
    };
    const email = { sendVerificationCode: jest.fn(() => Promise.resolve()) };
    const service = new AuthService(
      prisma as never,
      { sign: () => 'access' } as never,
      { get: () => undefined } as never,
      users as never,
      email as never,
      redis,
    );
    return { service, users, prisma, email };
  }

  const wrongTries = async (service: AuthService, n: number) => {
    for (let i = 0; i < n; i++) {
      await expect(service.verifyEmail('u1', String(100000 + i))).rejects.toBeInstanceOf(NotFoundException);
    }
  };

  it('refuses even the right code once the account has used its tries, and spends the code', async () => {
    const { service, users, prisma } = await build();
    await wrongTries(service, VERIFY_CODE_LIMIT.MAX_ATTEMPTS);

    const refused: unknown = await service.verifyEmail('u1', '123456').catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(users.verifyEmail).toHaveBeenCalledTimes(VERIFY_CODE_LIMIT.MAX_ATTEMPTS);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', emailVerified: false },
      data: { emailVerifyCode: null, emailVerifyExpires: null },
    });
  });

  it('counts tries arriving together, so a burst cannot all be checked', async () => {
    const { service, users } = await build();

    await Promise.allSettled(Array.from({ length: 40 }, (_, i) => service.verifyEmail('u1', String(200000 + i))));

    expect(users.verifyEmail).toHaveBeenCalledTimes(VERIFY_CODE_LIMIT.MAX_ATTEMPTS);
  });

  it('gives a newly sent code its own tries', async () => {
    const { service, email } = await build();
    await wrongTries(service, VERIFY_CODE_LIMIT.MAX_ATTEMPTS);

    await service.resendVerification('u1');

    expect(email.sendVerificationCode).toHaveBeenCalledWith('new@shop.com', '654321');
    await expect(service.verifyEmail('u1', '654321')).resolves.toMatchObject({ user: { id: 'u1', emailVerified: true } });
  });
});
