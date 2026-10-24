import { randomUUID } from 'node:crypto';
import type { RedisService } from '../../redis/redis.service';

const ACQUIRE_LUA = `return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')`;
/** Only the holder releases: a lock that expired and was taken by someone else stays theirs. */
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class LockTimeoutError extends Error { }

/**
 * Runs `fn` while holding the lock `key`, shared by every server. Waits up
 * to `waitMs` for it, then throws LockTimeoutError so the caller's job is
 * retried. The lock expires after `ttlMs` if its holder dies.
 */
export async function withRedisLock<T>(
    redis: Pick<RedisService, 'runScript'>,
    key: string,
    fn: () => Promise<T>,
    opts: { ttlMs?: number; waitMs?: number; pollMs?: number } = {},
): Promise<T> {
    const { ttlMs = 60_000, waitMs = 15_000, pollMs = 100 } = opts;
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    while ((await redis.runScript('lockAcquire', ACQUIRE_LUA, 1, [key], [token, ttlMs])) !== 'OK') {
        if (Date.now() >= deadline) throw new LockTimeoutError(`${key} is still held after ${waitMs / 1000} seconds.`);
        await new Promise((r) => setTimeout(r, pollMs));
    }
    try {
        return await fn();
    } finally {
        await redis.runScript('lockRelease', RELEASE_LUA, 1, [key], [token]).catch(() => undefined);
    }
}
