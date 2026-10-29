import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { LocalFallbackLimiter } from './local-fallback.limiter';
import {
  BREAKER_OPEN_KEYS,
  BREAKER_OPEN_LUA,
  OBSERVE_KEYS,
  OBSERVE_LUA,
  RELEASE_KEYS,
  RELEASE_LUA,
  RESERVE_KEYS,
  RESERVE_LUA,
  SETTLE_KEYS,
  SETTLE_LUA,
  THROTTLED_KEYS,
  THROTTLED_LUA,
} from './rate-limit.scripts';
import {
  DenyReason,
  Lease,
  MetaObservation,
  Observation,
  Priority,
  RateLimitMode,
  RateLimitScope,
  RateLimitedError,
  ReserveDecision,
  ReserveReason,
  scopeKey,
} from './rate-limit.types';
import {
  MetaPolicyConfig,
  PhoneThroughputPolicy,
  PolicySet,
  PriorityTable,
  ShopifyPolicyConfig,
  TokenBucketPolicy,
  UsageWindowPolicy,
  pick,
  policyFor,
} from './policies';

export interface ReserveOptions {
  priority: Priority;
  /// Caller's cost hint in the first scope's units. Undefined = policy default.
  cost?: number;
  channelId?: string;
}

export interface BreakerOpenEvent {
  scope: RateLimitScope;
  untilMs: number;
  reason: string;
  channelId?: string;
}

export interface ScopeState {
  key: string;
  bucket: Record<string, string>;
  breaker: Record<string, string> | null;
  inflight: Record<string, string>;
  today: Record<string, string>;
}

const keys = {
  bucket: (s: RateLimitScope) => scopeKey(s),
  leases: (s: RateLimitScope) => `rl:lease:${s.platform}:${s.kind}:${s.id}`,
  inflight: (s: RateLimitScope) => `rl:inflight:${s.platform}:${s.kind}:${s.id}`,
  breaker: (s: RateLimitScope) => `rl:breaker:${s.platform}:${s.kind}:${s.id}`,
  stats: (s: RateLimitScope) =>
    `rl:stats:${s.platform}:${s.id}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
};

/// How long Redis is skipped once we conclude it is genuinely unavailable.
const DEGRADED_WINDOW_MS = 10_000;
/// Consecutive failures before we draw that conclusion.
///
/// One slow call is not an outage. Measured against Upstash from here the
/// median script call is ~50ms but the tail reaches ~600ms, so a single
/// timeout happens regularly — and treating that as "Redis is down" switched
/// the limiter off for ten seconds at a time, leaving most traffic unmetered.
/// A real outage fails every call, so it still trips within a few requests.
const DEGRADE_AFTER_FAILURES = 3;

/**
 * The one limiter every outbound client shares.
 *
 * Knows nothing about Shopify or Meta: only scopes, costs, priorities and the
 * five Lua scripts. Everything platform-specific lives in the clients and in
 * the policy numbers. If you ever find `if (platform === 'shopify')` in here,
 * it belongs in an adapter instead.
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly policies: PolicySet;
  private readonly redisTimeoutMs: number;
  private readonly maxWaitMs: PriorityTable;
  private readonly parkThresholdMs: PriorityTable;
  private readonly breakerListeners: Array<(e: BreakerOpenEvent) => void> = [];
  private degradedUntil = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly fallback: LocalFallbackLimiter,
  ) {
    const shopify = this.config.get<ShopifyPolicyConfig>('rateLimit.shopify')!;
    const meta = this.config.get<MetaPolicyConfig>('rateLimit.meta')!;
    this.policies = {
      shopify: new TokenBucketPolicy(shopify),
      metaWindow: new UsageWindowPolicy(meta),
      metaPhone: new PhoneThroughputPolicy(meta),
    };
    this.redisTimeoutMs = this.config.get<number>('rateLimit.redisTimeoutMs') ?? 250;
    this.maxWaitMs = this.config.get<PriorityTable>('rateLimit.wait.maxWaitMs')!;
    this.parkThresholdMs = this.config.get<PriorityTable>('rateLimit.wait.parkThresholdMs')!;
  }

  mode(): RateLimitMode {
    return this.config.get<RateLimitMode>('rateLimit.mode') ?? 'observe';
  }

  /** Subscribe to breaker openings (the channel-state writer uses this). */
  onBreakerOpen(listener: (e: BreakerOpenEvent) => void): void {
    this.breakerListeners.push(listener);
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Ask every scope "may I spend now?", in the order given. Returns a lease
   * when all agree; otherwise sleeps briefly and retries, or throws
   * `RateLimitedError` when the wait is long enough that the caller should
   * park instead of holding a worker.
   */
  async reserve(scopes: RateLimitScope[], opts: ReserveOptions): Promise<Lease> {
    const mode = this.mode();
    if (mode === 'off' || scopes.length === 0) return this.noopLease(scopes, opts);

    const bound = pick(this.maxWaitMs, opts.priority);
    const parkThreshold = pick(this.parkThresholdMs, opts.priority);
    const started = Date.now();

    for (;;) {
      const decisions = await this.tryReserveAll(scopes, opts);
      const denied = decisions.find((d) => !d.allowed);
      if (!denied) return this.leaseFrom(decisions, scopes, opts);

      await this.releasePartial(decisions, opts.priority);
      const waitMs = this.jitter(denied.waitMs);
      const ctx = this.ctx(denied.scope, opts);

      if (mode === 'observe') {
        this.log('rate_limit.would_wait', { ...ctx, waitMs, reason: denied.reason });
        return this.noopLease(scopes, opts);
      }

      const tooLong = denied.reason === 'BREAKER' || waitMs > parkThreshold;
      const overBudget = Date.now() - started + waitMs > bound;
      if (tooLong || overBudget) {
        this.log('rate_limit.park', { ...ctx, waitMs, reason: denied.reason });
        throw new RateLimitedError(denied.scope, Date.now() + waitMs, denied.reason as DenyReason);
      }

      this.log('rate_limit.wait', { ...ctx, waitMs, reason: denied.reason });
      await this.sleep(waitMs);
    }
  }

  /**
   * Close the receipt. Pass the real cost, and the platform's own balance when
   * it reported one — that observation overwrites our estimate.
   */
  async settle(
    lease: Lease,
    result: { actualCost?: number; observation?: Observation } = {},
  ): Promise<void> {
    if (lease.noop) {
      // Observations are still valuable in observe mode: the wallets learn
      // the truth while nothing is enforced.
      if (result.observation && lease.scopes[0]) {
        await this.absorbObservation(lease.scopes[0], result.observation);
      }
      return;
    }
    const o = result.observation;
    for (const [i, scope] of lease.scopes.entries()) {
      if (o) this.fallback.seed(keys.bucket(scope), o);
      await this.run(
        'rlSettle',
        SETTLE_LUA,
        SETTLE_KEYS,
        [keys.bucket(scope), keys.leases(scope), keys.inflight(scope)],
        [
          Date.now(),
          this.member(lease.leaseIds[i], lease.costs[i], lease.priority),
          lease.costs[i],
          result.actualCost ?? -1,
          o?.available ?? -1,
          o?.max ?? -1,
          o?.rate ?? -1,
          o?.at ?? Date.now(),
          lease.priority,
        ],
      );
    }
  }

  /** Feed a Meta usage percentage into a wallet. */
  async observe(scope: RateLimitScope, obs: MetaObservation): Promise<void> {
    if (this.mode() === 'off') return;
    const p = policyFor(this.policies, scope);
    const regainAt = obs.regainMinutes ? Date.now() + obs.regainMinutes * 60_000 : -1;
    await this.run(
      'rlObserve',
      OBSERVE_LUA,
      OBSERVE_KEYS,
      [keys.bucket(scope)],
      [
        Date.now(),
        obs.pct,
        obs.windowSeconds ?? p.windowSeconds,
        regainAt,
        obs.callsSinceLast ?? 1,
        p.keyTtlS,
        p.defaultPpc,
      ],
    );
    if (regainAt > 0) {
      this.log('rate_limit.regain_wait', { scope: scopeKey(scope), regainAt });
    }
  }

  /**
   * Shut the door on a wallet after the remote API actually refused us.
   * Returns the epoch ms at which it reopens.
   */
  async openBreaker(
    scope: RateLimitScope,
    o: { hintMs?: number; reason: string; channelId?: string },
  ): Promise<number> {
    if (this.mode() === 'off') return Date.now();
    const p = policyFor(this.policies, scope);
    const raw = await this.run(
      'rlBreakerOpen',
      BREAKER_OPEN_LUA,
      BREAKER_OPEN_KEYS,
      [keys.breaker(scope), keys.stats(scope)],
      [Date.now(), p.breakerMinMs, p.breakerMaxMs, o.hintMs ?? -1, o.reason],
    );
    const untilMs = Number(raw);
    this.log('rate_limit.breaker_open', {
      scope: scopeKey(scope),
      channelId: o.channelId,
      until: new Date(untilMs).toISOString(),
      reason: o.reason,
    });
    for (const l of this.breakerListeners) {
      try {
        l({ scope, untilMs, reason: o.reason, channelId: o.channelId });
      } catch (err) {
        this.logger.warn(`breaker listener threw: ${String(err)}`);
      }
    }
    return untilMs;
  }

  async closeBreaker(scope: RateLimitScope): Promise<void> {
    await this.redis.del(keys.breaker(scope));
    this.log('rate_limit.breaker_close', { scope: scopeKey(scope) });
  }

  /** A real 429 / THROTTLED / Meta throttle code reached us. This is the
   *  counter that should read zero once enforcement is on. */
  async recordThrottled(scope: RateLimitScope, detail: Record<string, unknown> = {}): Promise<void> {
    this.log('rate_limit.throttled', { scope: scopeKey(scope), ...detail });
    if (this.mode() === 'off') return;
    await this.run('rlThrottled', THROTTLED_LUA, THROTTLED_KEYS, [keys.stats(scope)], []);
  }

  async getState(scope: RateLimitScope): Promise<ScopeState> {
    const [bucket, breaker, inflight, today] = await Promise.all([
      this.redis.hgetall(keys.bucket(scope)),
      this.redis.hgetall(keys.breaker(scope)),
      this.redis.hgetall(keys.inflight(scope)),
      this.redis.hgetall(keys.stats(scope)),
    ]);
    const breakerActive = breaker.until && Number(breaker.until) > Date.now();
    return {
      key: scopeKey(scope),
      bucket,
      breaker: breakerActive ? breaker : null,
      inflight,
      today,
    };
  }

  /** Reserve, run, and always settle — for callers that do not inspect cost. */
  async withLease<T>(
    scopes: RateLimitScope[],
    opts: ReserveOptions,
    fn: (lease: Lease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.reserve(scopes, opts);
    try {
      return await fn(lease);
    } finally {
      await this.settle(lease, { actualCost: 0 }).catch(() => undefined);
    }
  }

  // ── reserve internals ─────────────────────────────────────────────────────

  private async tryReserveAll(
    scopes: RateLimitScope[],
    opts: ReserveOptions,
  ): Promise<ReserveDecision[]> {
    const out: ReserveDecision[] = [];
    for (const scope of scopes) {
      const p = policyFor(this.policies, scope);
      const leaseId = randomBytes(4).toString('hex');
      const raw = (await this.run(
        'rlReserve',
        RESERVE_LUA,
        RESERVE_KEYS,
        [
          keys.bucket(scope),
          keys.leases(scope),
          keys.inflight(scope),
          keys.breaker(scope),
          keys.stats(scope),
        ],
        [
          Date.now(),
          p.costFor(scope, opts.cost),
          opts.priority,
          leaseId,
          p.max,
          p.rate,
          p.watermark(opts.priority),
          p.inflightCap(opts.priority),
          p.leaseTtlMs,
          p.keyTtlS,
          p.defaultCost > 0 ? p.defaultCost : p.defaultPpc,
        ],
      )) as [number, number, ReserveReason, number?, string?];
      const d: ReserveDecision = {
        scope,
        allowed: Number(raw[0]) === 1,
        waitMs: Number(raw[1]),
        reason: raw[2],
        leaseId,
        cost: Number(raw[4] ?? p.costFor(scope, opts.cost)),
        available: raw[3] === undefined ? undefined : Number(raw[3]),
      };
      out.push(d);
      if (!d.allowed) break;
    }
    return out;
  }

  private async releasePartial(decisions: ReserveDecision[], priority: Priority): Promise<void> {
    for (const d of decisions) {
      if (!d.allowed) continue;
      await this.run(
        'rlRelease',
        RELEASE_LUA,
        RELEASE_KEYS,
        [keys.bucket(d.scope), keys.leases(d.scope), keys.inflight(d.scope)],
        [this.member(d.leaseId, d.cost, priority), d.cost, priority],
      );
    }
  }

  private async absorbObservation(scope: RateLimitScope, o: Observation): Promise<void> {
    this.fallback.seed(keys.bucket(scope), o);
    await this.run(
      'rlSettle',
      SETTLE_LUA,
      SETTLE_KEYS,
      [keys.bucket(scope), keys.leases(scope), keys.inflight(scope)],
      [Date.now(), 'noop|0|0', 0, -1, o.available, o.max, o.rate, o.at, 0],
    );
  }

  private leaseFrom(
    decisions: ReserveDecision[],
    scopes: RateLimitScope[],
    opts: ReserveOptions,
  ): Lease {
    return {
      leaseIds: decisions.map((d) => d.leaseId),
      costs: decisions.map((d) => d.cost),
      scopes,
      priority: opts.priority,
      channelId: opts.channelId,
      noop: false,
    };
  }

  private noopLease(scopes: RateLimitScope[], opts: ReserveOptions): Lease {
    return {
      leaseIds: [],
      costs: [],
      scopes,
      priority: opts.priority,
      channelId: opts.channelId,
      noop: true,
    };
  }

  private member(leaseId: string, cost: number, priority: Priority): string {
    return `${leaseId}|${cost}|${priority}`;
  }

  // ── redis with a safety net ───────────────────────────────────────────────

  /**
   * Every script goes through here. Capped at `redisTimeoutMs`; one failure
   * flips to the in-memory fallback for ten seconds so a slow Redis costs one
   * timeout, not one per request. Requests are never blocked by the limiter's
   * own storage being unavailable — a few 429s beat a stalled queue.
   */
  private async run(
    name: string,
    lua: string,
    nKeys: number,
    k: string[],
    args: unknown[],
  ): Promise<unknown> {
    if (Date.now() < this.degradedUntil) return this.fallback.run(name, k, args);
    try {
      const out = await Promise.race([
        this.redis.runScript(name, lua, nKeys, k, args),
        this.rejectAfter(this.redisTimeoutMs),
      ]);
      this.consecutiveFailures = 0;
      return out;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= DEGRADE_AFTER_FAILURES) {
        const wasHealthy = Date.now() >= this.degradedUntil;
        this.degradedUntil = Date.now() + DEGRADED_WINDOW_MS;
        if (wasHealthy) {
          this.log('rate_limit.redis_degraded', { error: String(err), script: name });
        }
      } else {
        // A blip: this one request goes unmetered rather than waiting, but the
        // limiter stays on for everything else.
        this.log('rate_limit.redis_slow', {
          error: String(err),
          script: name,
          consecutiveFailures: this.consecutiveFailures,
        });
      }
      return this.fallback.run(name, k, args);
    }
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  private jitter(ms: number): number {
    return Math.max(50, Math.floor(ms + Math.random() * Math.min(500, ms * 0.25)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private rejectAfter(ms: number): Promise<never> {
    return new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`rate limiter redis call exceeded ${ms}ms`)), ms).unref?.(),
    );
  }

  private ctx(scope: RateLimitScope, opts: ReserveOptions) {
    return {
      scope: scopeKey(scope),
      priority: opts.priority,
      channelId: opts.channelId,
    };
  }

  private log(event: string, fields: Record<string, unknown>): void {
    const line = JSON.stringify({ event, ...fields });
    if (event === 'rate_limit.throttled' || event === 'rate_limit.redis_degraded') {
      this.logger.warn(line);
    } else if (event === 'rate_limit.redis_slow') {
      this.logger.debug(line);
    } else if (event === 'rate_limit.would_wait' || event === 'rate_limit.wait') {
      this.logger.debug(line);
    } else {
      this.logger.log(line);
    }
  }
}
