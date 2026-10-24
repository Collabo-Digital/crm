import RedisMock from 'ioredis-mock';
import { RedisService } from './redis.service';
import { EMAIL_SEND_LIMIT, LOGIN_RATE_LIMIT, REDIS_KEYS, REDIS_PREFIX } from './redis.constants';

/** RedisService over ioredis-mock, which runs the real commands and Lua. */
function build() {
  const service = new RedisService({ get: () => 'redis://localhost:6379' } as never);
  const client = new RedisMock();
  (service as unknown as { client: unknown }).client = client;
  return { service, client };
}

const userTokensKey = (userId: string) => REDIS_PREFIX + REDIS_KEYS.USER_REFRESH_TOKENS + userId;
const userSidsKey = (userId: string) => REDIS_PREFIX + REDIS_KEYS.USER_AUTH_SESSIONS + userId;

describe('RedisService', () => {
  let built: ReturnType<typeof build>;
  beforeEach(async () => {
    built = build();
    await built.client.flushall();
  });

  describe('login attempts', () => {
    it('lets through only the allowed number of a burst of parallel attempts', async () => {
      const { service } = built;

      const refused = await Promise.all(
        Array.from({ length: 40 }, () => service.countLoginAttempt('Owner@Shop.com', '1.2.3.4')),
      );

      expect(refused.filter((r) => !r)).toHaveLength(LOGIN_RATE_LIMIT.MAX_ATTEMPTS);
    });

    it('does not lock the owner out from their own IP address because of attempts from another', async () => {
      const { service } = built;
      for (let i = 0; i < 10; i++) await service.countLoginAttempt('owner@shop.com', '6.6.6.6');

      expect(await service.countLoginAttempt('owner@shop.com', '1.2.3.4')).toBe(false);
      expect(await service.countLoginAttempt('owner@shop.com', '6.6.6.6')).toBe(true);
    });

    it('caps attempts on one address spread over many IP addresses', async () => {
      const { service } = built;
      for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS_ANY_IP; i++) {
        await service.countLoginAttempt('owner@shop.com', `10.0.0.${i}`);
      }

      expect(await service.countLoginAttempt('owner@shop.com', '1.2.3.4')).toBe(true);
    });

    it('a successful login clears the count', async () => {
      const { service } = built;
      for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS; i++) await service.countLoginAttempt('owner@shop.com', '1.2.3.4');

      await service.resetLoginAttempts('owner@shop.com', '1.2.3.4');

      expect(await service.countLoginAttempt('owner@shop.com', '1.2.3.4')).toBe(false);
    });
  });

  describe('email send limit', () => {
    it('sends one email per gap, whatever the casing of the address', async () => {
      const { service } = built;

      expect(await service.allowEmailSend('password-reset', 'Priya@Shop.com')).toBe(true);
      expect(await service.allowEmailSend('password-reset', 'priya@shop.com')).toBe(false);
      expect(await service.allowEmailSend('password-reset', 'other@shop.com')).toBe(true);
    });

    it('stops after the hourly cap even when the gap is respected', async () => {
      const { service, client } = built;
      const gapKey = REDIS_PREFIX + REDIS_KEYS.EMAIL_SEND_GAP + 'password-reset:priya@shop.com';
      const results: boolean[] = [];
      for (let i = 0; i <= EMAIL_SEND_LIMIT.MAX_PER_HOUR; i++) {
        results.push(await service.allowEmailSend('password-reset', 'priya@shop.com'));
        await client.del(gapKey);
      }

      expect(results.filter(Boolean)).toHaveLength(EMAIL_SEND_LIMIT.MAX_PER_HOUR);
      expect(results[EMAIL_SEND_LIMIT.MAX_PER_HOUR]).toBe(false);
    });
  });

  describe('refresh tokens', () => {
    it('forgets a refresh token once it is spent or revoked', async () => {
      const { service, client } = built;
      for (const token of ['t1', 't2']) {
        await service.setRefreshToken(token, { userId: 'u1', sid: 's1' });
        await service.trackUserToken('u1', token);
      }

      await service.consumeRefreshToken('t1');
      await service.deleteRefreshToken('t2', 'u1');

      expect(await client.smembers(userTokensKey('u1'))).toEqual([]);
    });

    it('revokes every refresh token but those of the kept session', async () => {
      const { service, client } = built;
      for (const [token, sid] of [['mine', 's-keep'], ['other', 's-other'], ['older', 's-other']]) {
        await service.setRefreshToken(token, { userId: 'u1', sid });
        await service.trackUserToken('u1', token);
      }

      await service.deleteAllUserTokens('u1', 's-keep');

      expect(await service.getRefreshToken('mine')).toMatchObject({ sid: 's-keep' });
      expect(await service.getRefreshToken('other')).toBeNull();
      expect(await service.getRefreshToken('older')).toBeNull();
      expect(await client.smembers(userTokensKey('u1'))).toEqual(['mine']);
    });

    it('revokes them all when no session is kept', async () => {
      const { service, client } = built;
      await service.setRefreshToken('t1', { userId: 'u1', sid: 's1' });
      await service.trackUserToken('u1', 't1');

      await service.deleteAllUserTokens('u1');

      expect(await service.getRefreshToken('t1')).toBeNull();
      expect(await client.exists(userTokensKey('u1'))).toBe(0);
    });
  });

  describe('auth sessions', () => {
    it('ends every session but the kept one', async () => {
      const { service, client } = built;
      await service.setAuthSession('s-keep', 'u1');
      await service.setAuthSession('s-other', 'u1');

      await service.deleteAllAuthSessions('u1', 's-keep');

      expect(await service.isAuthSessionActive('s-keep', 'u1')).toBe(true);
      expect(await service.isAuthSessionActive('s-other', 'u1')).toBe(false);
      expect(await client.smembers(userSidsKey('u1'))).toEqual(['s-keep']);
    });

    it('ends them all when none is kept', async () => {
      const { service } = built;
      await service.setAuthSession('s1', 'u1');

      await service.deleteAllAuthSessions('u1');

      expect(await service.isAuthSessionActive('s1', 'u1')).toBe(false);
    });
  });
});
