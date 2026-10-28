import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_PREFIX, REDIS_KEYS, REDIS_TTL, LOGIN_RATE_LIMIT, EMAIL_SEND_LIMIT } from './redis.constants';

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
    // Every attempt is counted BEFORE the password is checked. Reading the
    // count and adding to it after a failure let parallel guesses all read the
    // same count, so none of them was ever blocked; INCR is atomic, so each
    // request sees its own number. Counted per address from one IP, and per
    // address from anywhere with a higher limit (see LOGIN_RATE_LIMIT).

    private async countInWindow(k: string, windowSeconds: number): Promise<number> {
        const count = await this.client.incr(k);
        if (count === 1) await this.client.expire(k, windowSeconds);
        return count;
    }

    private loginKeys(email: string, ip: string): [string, string] {
        const address = email.trim().toLowerCase();
        return [this.key(REDIS_KEYS.LOGIN_ATTEMPTS, `${address}:${ip}`), this.key(REDIS_KEYS.LOGIN_ATTEMPTS, address)];
    }

    /** Count one login attempt; true when it is over the limit and must be refused. */
    async countLoginAttempt(email: string, ip: string): Promise<boolean> {
        const [fromIp, anyIp] = this.loginKeys(email, ip);
        const [ipCount, total] = await Promise.all([
            this.countInWindow(fromIp, LOGIN_RATE_LIMIT.WINDOW_SECONDS),
            this.countInWindow(anyIp, LOGIN_RATE_LIMIT.WINDOW_SECONDS),
        ]);
        return ipCount > LOGIN_RATE_LIMIT.MAX_ATTEMPTS || total > LOGIN_RATE_LIMIT.MAX_ATTEMPTS_ANY_IP;
    }

    async resetLoginAttempts(email: string, ip: string): Promise<void> {
        await this.client.del(...this.loginKeys(email, ip));
    }

    // ─── EMAIL SEND LIMITS ───

    /**
     * Whether one more email of `kind` may go to `recipient` now, counting it
     * if so: at most one per EMAIL_SEND_LIMIT.MIN_GAP_SECONDS and
     * MAX_PER_HOUR an hour. Stops a public form being used to flood an inbox
     * or burn the SMTP quota.
     */
    async allowEmailSend(kind: string, recipient: string): Promise<boolean> {
        const id = `${kind}:${recipient.trim().toLowerCase()}`;
        const gapFree = await this.client.set(
            this.key(REDIS_KEYS.EMAIL_SEND_GAP, id), '1', 'EX', EMAIL_SEND_LIMIT.MIN_GAP_SECONDS, 'NX',
        );
        if (gapFree !== 'OK') return false;
        const sentThisHour = await this.countInWindow(this.key(REDIS_KEYS.EMAIL_SEND_COUNT, id), 3600);
        return sentThisHour <= EMAIL_SEND_LIMIT.MAX_PER_HOUR;
    }

    // ─── UPLOAD QUOTA ───

    private uploadKey(orgId: string): string {
        return this.key(REDIS_KEYS.UPLOAD_BYTES, `${orgId}:${new Date().toISOString().slice(0, 10)}`);
    }

    async uploadedBytesToday(orgId: string): Promise<number> {
        return Number(await this.client.get(this.uploadKey(orgId))) || 0;
    }

    /**
     * Add `bytes` to the workspace's uploads today, unless that passes `limit`:
     * then nothing is added and the answer is false. INCRBY first, so two
     * uploads at once cannot both slip under the limit.
     */
    async addUploadedBytes(orgId: string, bytes: number, limit: number): Promise<boolean> {
        const key = this.uploadKey(orgId);
        const total = await this.client.incrby(key, bytes);
        if (total === bytes) await this.client.expire(key, 2 * 86400);
        if (total <= limit) return true;
        await this.client.decrby(key, bytes);
        return false;
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
        if (!raw) return null;
        const data = JSON.parse(raw) as T;
        const userId = (data as { userId?: unknown }).userId;
        if (typeof userId === 'string') await this.untrackUserToken(userId, token);
        return data;
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

    async deleteRefreshToken(token: string, userId?: string): Promise<void> {
        await this.client.del(this.key(REDIS_KEYS.REFRESH_TOKEN, token));
        if (userId) await this.untrackUserToken(userId, token);
    }

    // The per-user set lists the refresh tokens a revoke-all must delete. A
    // token leaves it when it is spent or revoked; otherwise every rotation
    // (about four an hour per open tab) added one that was never removed, and
    // the set of an active user never expired.
    async trackUserToken(userId: string, token: string): Promise<void> {
        const setKey = this.key(REDIS_KEYS.USER_REFRESH_TOKENS, userId);
        await this.client.sadd(setKey, token);
        await this.client.expire(setKey, REDIS_TTL.REFRESH_TOKEN);
    }

    private async untrackUserToken(userId: string, token: string): Promise<void> {
        await this.client.srem(this.key(REDIS_KEYS.USER_REFRESH_TOKENS, userId), token);
    }

    /** Revoke a user's refresh tokens, except the ones of session `keepSid`. */
    async deleteAllUserTokens(userId: string, keepSid?: string): Promise<void> {
        const setKey = this.key(REDIS_KEYS.USER_REFRESH_TOKENS, userId);
        const tokens = await this.client.smembers(setKey);
        if (tokens.length === 0) return;

        let doomed = tokens;
        if (keepSid) {
            const values = await this.client.mget(tokens.map((t) => this.key(REDIS_KEYS.REFRESH_TOKEN, t)));
            doomed = tokens.filter((_, i) => {
                const raw = values[i];
                return !raw || (JSON.parse(raw) as { sid?: string }).sid !== keepSid;
            });
            if (doomed.length === 0) return;
        }

        const pipeline = this.client.pipeline();
        for (const token of doomed) {
            pipeline.del(this.key(REDIS_KEYS.REFRESH_TOKEN, token));
        }
        if (keepSid) pipeline.srem(setKey, ...doomed);
        else pipeline.del(setKey);
        await pipeline.exec();
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

    /** End a user's sessions, except `keepSid`. */
    async deleteAllAuthSessions(userId: string, keepSid?: string): Promise<void> {
        const setKey = this.key(REDIS_KEYS.USER_AUTH_SESSIONS, userId);
        const sids = (await this.client.smembers(setKey)).filter((sid) => sid !== keepSid);

        const pipeline = this.client.pipeline();
        for (const sid of sids) {
            pipeline.del(this.key(REDIS_KEYS.AUTH_SESSION, sid));
        }
        if (!keepSid) pipeline.del(setKey);
        else if (sids.length > 0) pipeline.srem(setKey, ...sids);
        await pipeline.exec();
    }
}
