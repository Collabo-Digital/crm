import RedisMock from 'ioredis-mock';
import { AuthService } from '../auth/auth.service';
import { RedisService } from '../redis/redis.service';
import { UserController } from './user.controller';

/** The real session store (RedisService over ioredis-mock) behind AuthService and the controller. */
function build() {
  const redis = new RedisService({ get: () => 'redis://localhost:6379' } as never);
  (redis as unknown as { client: unknown }).client = new RedisMock();
  const prisma = { refreshToken: { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) } };
  const auth = new AuthService(prisma as never, {} as never, { get: () => '7d' } as never, {} as never, {} as never, redis);
  return { redis, controller: new UserController({} as never, auth) };
}

describe('Settings › Security › Sign out of other devices', () => {
  it('ends the account’s sessions on other devices and keeps this one', async () => {
    const { redis, controller } = build();
    for (const [sid, token] of [['s-phone', 'r-phone'], ['s-laptop', 'r-laptop'], ['s-here', 'r-here']]) {
      await redis.setAuthSession(sid, 'u1');
      await redis.setRefreshToken(token, { userId: 'u1', sid });
      await redis.trackUserToken('u1', token);
    }
    await redis.setAuthSession('s-someone-else', 'u2');

    await expect(controller.signOutOtherDevices({ sub: 'u1', email: 'u1@test.local', sid: 's-here' })).resolves.toEqual({
      message: 'Signed out of every other device.',
    });

    expect(await redis.isAuthSessionActive('s-here', 'u1')).toBe(true);
    expect(await redis.getRefreshToken('r-here')).toMatchObject({ sid: 's-here' });
    expect(await redis.isAuthSessionActive('s-phone', 'u1')).toBe(false);
    expect(await redis.isAuthSessionActive('s-laptop', 'u1')).toBe(false);
    expect(await redis.getRefreshToken('r-phone')).toBeNull();
    expect(await redis.getRefreshToken('r-laptop')).toBeNull();
    // Another account is untouched.
    expect(await redis.isAuthSessionActive('s-someone-else', 'u2')).toBe(true);
  });
});
