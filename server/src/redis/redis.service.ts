import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_PREFIX, REDIS_KEYS, REDIS_TTL, LOGIN_RATE_LIMIT } from './redis.constants';

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
}
