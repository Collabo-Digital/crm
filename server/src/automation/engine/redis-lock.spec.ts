import { LockTimeoutError, withRedisLock } from './redis-lock';

function fakeRedis() {
    const held = new Map<string, string>();
    return {
        held,
        runScript: jest.fn(async (name: string, _lua: string, _keys: number, [key]: string[], [token]: unknown[]) => {
            if (name === 'lockAcquire') {
                if (held.has(key)) return null;
                held.set(key, String(token));
                return 'OK';
            }
            if (held.get(key) !== String(token)) return 0;
            held.delete(key);
            return 1;
        }),
    };
}

describe('withRedisLock', () => {
    it('runs holders of one key one after another, and releases on failure', async () => {
        const redis = fakeRedis();
        const log: string[] = [];
        const work = (name: string, fail = false) =>
            withRedisLock(redis, 'k', async () => {
                log.push(`${name} in`);
                await new Promise((r) => setTimeout(r, 15));
                log.push(`${name} out`);
                if (fail) throw new Error('boom');
            }, { pollMs: 5 });
        const results = await Promise.allSettled([work('a', true), work('b')]);
        expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
        expect(log).toEqual(['a in', 'a out', 'b in', 'b out']);
        expect(redis.held.size).toBe(0);
    });

    it('gives up after waiting, and never releases a lock it does not hold', async () => {
        const redis = fakeRedis();
        redis.held.set('k', 'someone else');
        await expect(withRedisLock(redis, 'k', async () => 1, { waitMs: 30, pollMs: 5 })).rejects.toBeInstanceOf(LockTimeoutError);
        expect(redis.held.get('k')).toBe('someone else');
    });
});
