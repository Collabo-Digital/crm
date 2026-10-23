import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_PREFIX, REDIS_KEYS, REDIS_TTL, LOGIN_RATE_LIMIT } from './redis.constants';

const REFRESH_ROTATION_PENDING = 'pending';

/** KEYS[1] refresh token, KEYS[2] rotation marker, ARGV[1] marker TTL (s). */
const CONSUME_REFRESH_TOKEN_LUA = `
local value = redis.call('GET', KEYS[1])
if value then
    redis.call('DEL', KEYS[1])
    redis.call('SET', KEYS[2], '${REFRESH_ROTATION_PENDING}', 'EX', ARGV[1])
end
return value`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RedisService.name);
    private readonly client: Redis;

    constructor(private readonly config: ConfigService) {
        this.client = new Redis(this.config.get<string>('redis.url')!, {
            maxRetriesPerRequest: 3,
            lazyConnect: true,
        });
    }

    async onModuleInit() {
        await this.client.connect();
        this.logger.log('Redis connection established');
    }

    async onModuleDestroy() {
        await this.client.quit();
    }

    private key(prefix: string, id: string): string {
        return REDIS_PREFIX + prefix + id;
    }

    // ─── LUA SCRIPTS ───

    private readonly definedScripts = new Set<string>();

    /**
     * Run a Lua script atomically. Registered once per name via
     * `defineCommand` (ioredis then sends only the SHA and re-uploads on
     * NOSCRIPT). Keys are prefixed like every other key this service owns;
     * args are stringified because Redis only speaks strings.
     */
    async runScript(
        name: string,
        lua: string,
        numberOfKeys: number,
        keys: string[],
        args: unknown[],
    ): Promise<unknown> {
        if (!this.definedScripts.has(name)) {
            this.client.defineCommand(name, { lua, numberOfKeys });
            this.definedScripts.add(name);
        }
        const fn = (this.client as unknown as Record<string, (...a: string[]) => Promise<unknown>>)[name];
        return await fn.call(
            this.client,
            ...keys.map((k) => REDIS_PREFIX + k),
            ...args.map((a) => String(a)),
        );
    }

    async hgetall(key: string): Promise<Record<string, string>> {
        return this.client.hgetall(REDIS_PREFIX + key);
    }

    // ─── GENERIC ───

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        await this.client.setex(REDIS_PREFIX + key, ttlSeconds, JSON.stringify(value));
    }

    async get<T>(key: string): Promise<T | null> {
        const raw = await this.client.get(REDIS_PREFIX + key);
        return raw ? (JSON.parse(raw) as T) : null;
    }

    async del(key: string): Promise<void> {
        await this.client.del(REDIS_PREFIX + key);
    }

    /**
     * Best-effort distributed lock (SET NX EX). Returns true when this caller
     * acquired the lock; release with `del(key)`. The TTL guarantees the lock
     * can never dead-lock if the holder crashes.
     */
    async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
        const result = await this.client.set(REDIS_PREFIX + key, '1', 'EX', ttlSeconds, 'NX');
        return result === 'OK';
    }

    // ─── SESSION CACHE ───

    async setSession(userId: string, data: Record<string, unknown>): Promise<void> {
        await this.client.setex(
            this.key(REDIS_KEYS.SESSION, userId),
            REDIS_TTL.SESSION,
            JSON.stringify(data),
        );
    }

    async getSession<T>(userId: string): Promise<T | null> {
        const raw = await this.client.get(this.key(REDIS_KEYS.SESSION, userId));
        return raw ? (JSON.parse(raw) as T) : null;
    }

    async deleteSession(userId: string): Promise<void> {
        await this.client.del(this.key(REDIS_KEYS.SESSION, userId));
    }

    // ─── LOGIN RATE LIMITING ───

    async incrementLoginAttempts(email: string): Promise<number> {
        const k = this.key(REDIS_KEYS.LOGIN_ATTEMPTS, email.toLowerCase());
        const count = await this.client.incr(k);
        if (count === 1) {
            await this.client.expire(k, LOGIN_RATE_LIMIT.WINDOW_SECONDS);
        }
        return count;
    }

    async getLoginAttempts(email: string): Promise<number> {
        const raw = await this.client.get(this.key(REDIS_KEYS.LOGIN_ATTEMPTS, email.toLowerCase()));
        return raw ? parseInt(raw, 10) : 0;
    }

    async resetLoginAttempts(email: string): Promise<void> {
        await this.client.del(this.key(REDIS_KEYS.LOGIN_ATTEMPTS, email.toLowerCase()));
    }

    isLoginBlocked(attempts: number): boolean {
        return attempts >= LOGIN_RATE_LIMIT.MAX_ATTEMPTS;
    }

    // ─── REFRESH TOKENS ───

    async setRefreshToken(token: string, data: Record<string, unknown>): Promise<void> {
        await this.client.setex(
            this.key(REDIS_KEYS.REFRESH_TOKEN, token),
            REDIS_TTL.REFRESH_TOKEN,
            JSON.stringify(data),
        );
    }

    async getRefreshToken<T>(token: string): Promise<T | null> {
        const raw = await this.client.get(this.key(REDIS_KEYS.REFRESH_TOKEN, token));
        return raw ? (JSON.parse(raw) as T) : null;
    }

    /**
     * Read a refresh token and delete it in one atomic step, so it can be
     * spent exactly once. With a separate get and del, two concurrent refreshes
     * both read it before either deleted it and both were issued new tokens.
     *
     * The caller that gets the data also leaves a short-lived 'pending' marker
     * (see getRefreshRotation) so a duplicate of the same request can wait for
     * its result. A script rather than GETDEL, which needs Redis 6.2+.
     */
    async consumeRefreshToken<T>(token: string): Promise<T | null> {
        const raw = (await this.client.eval(
            CONSUME_REFRESH_TOKEN_LUA,
            2,
            this.key(REDIS_KEYS.REFRESH_TOKEN, token),
            this.key(REDIS_KEYS.REFRESH_ROTATION, token),
            REDIS_TTL.REFRESH_ROTATION,
        )) as string | null;
        return raw ? (JSON.parse(raw) as T) : null;
    }

    // ─── REFRESH ROTATION GRACE ───
    // Two tabs share one refresh token and refresh at the same moment (wake
    // from sleep, network back). Only one may rotate it; the other is handed
    // the same replacement for a few seconds instead of being signed out.

    /** `'pending'` while the winning refresh is in flight, then its result. */
    async getRefreshRotation<T>(token: string): Promise<T | 'pending' | null> {
        const raw = await this.client.get(this.key(REDIS_KEYS.REFRESH_ROTATION, token));
        if (!raw) return null;
        return raw === REFRESH_ROTATION_PENDING ? 'pending' : (JSON.parse(raw) as T);
    }

    async setRefreshRotationResult(token: string, result: Record<string, unknown>): Promise<void> {
        await this.client.setex(
            this.key(REDIS_KEYS.REFRESH_ROTATION, token),
            REDIS_TTL.REFRESH_ROTATION,
            JSON.stringify(result),
        );
    }

    async clearRefreshRotation(token: string): Promise<void> {
        await this.client.del(this.key(REDIS_KEYS.REFRESH_ROTATION, token));
    }

    async deleteRefreshToken(token: string): Promise<void> {
        await this.client.del(this.key(REDIS_KEYS.REFRESH_TOKEN, token));
    }

    async trackUserToken(userId: string, token: string): Promise<void> {
        const setKey = this.key(REDIS_KEYS.USER_REFRESH_TOKENS, userId);
        await this.client.sadd(setKey, token);
        await this.client.expire(setKey, REDIS_TTL.REFRESH_TOKEN);
    }

    async deleteAllUserTokens(userId: string): Promise<void> {
        const setKey = this.key(REDIS_KEYS.USER_REFRESH_TOKENS, userId);
        const tokens = await this.client.smembers(setKey);

        if (tokens.length > 0) {
            const pipeline = this.client.pipeline();
            for (const token of tokens) {
                pipeline.del(this.key(REDIS_KEYS.REFRESH_TOKEN, token));
            }
            pipeline.del(setKey);
            await pipeline.exec();
        }
    }

    // ─── AUTH SESSIONS (revocable access tokens) ───

    /**
     * An access token is only honoured while its `sid` is present here. Lives
     * as long as a refresh token, and is extended on every rotation.
     */
    async setAuthSession(sid: string, userId: string): Promise<void> {
        const setKey = this.key(REDIS_KEYS.USER_AUTH_SESSIONS, userId);
        await this.client
            .multi()
            .setex(this.key(REDIS_KEYS.AUTH_SESSION, sid), REDIS_TTL.REFRESH_TOKEN, userId)
            .sadd(setKey, sid)
            .expire(setKey, REDIS_TTL.REFRESH_TOKEN)
            .exec();
    }

    /**
     * Extend a live session. Returns false when it has been revoked — it is
     * never re-created here, so a refresh racing a logout cannot resurrect it.
     */
    async touchAuthSession(sid: string, userId: string): Promise<boolean> {
        const alive = await this.client.expire(this.key(REDIS_KEYS.AUTH_SESSION, sid), REDIS_TTL.REFRESH_TOKEN);
        if (alive !== 1) return false;
        await this.client.expire(this.key(REDIS_KEYS.USER_AUTH_SESSIONS, userId), REDIS_TTL.REFRESH_TOKEN);
        return true;
    }

    async isAuthSessionActive(sid: string, userId: string): Promise<boolean> {
        return (await this.client.get(this.key(REDIS_KEYS.AUTH_SESSION, sid))) === userId;
    }

    async deleteAuthSession(sid: string, userId: string): Promise<void> {
        await this.client.del(this.key(REDIS_KEYS.AUTH_SESSION, sid));
        await this.client.srem(this.key(REDIS_KEYS.USER_AUTH_SESSIONS, userId), sid);
    }

    async deleteAllAuthSessions(userId: string): Promise<void> {
        const setKey = this.key(REDIS_KEYS.USER_AUTH_SESSIONS, userId);
        const sids = await this.client.smembers(setKey);

        const pipeline = this.client.pipeline();
        for (const sid of sids) {
            pipeline.del(this.key(REDIS_KEYS.AUTH_SESSION, sid));
        }
        pipeline.del(setKey);
        await pipeline.exec();
    }
}
