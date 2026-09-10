import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../redis/redis.service';

/**
 * Remembers what each Shopify query shape cost last time, so the NEXT
 * reservation for it is accurate instead of the flat default.
 *
 * Keyed by a hash of the query text plus the variables that change cost
 * (`first` / `last` / `limit`). Two layers: a small in-process map for the hot
 * path, and a Redis hash so a fresh process starts informed. Both are
 * best-effort — a miss just means the default cost is reserved and the real
 * cost corrects it after one call.
 */
interface CostHint {
  /// Exponential moving average of `requestedQueryCost`.
  req: number;
  /// Observations folded in.
  n: number;
}

const LRU_MAX = 500;
const REDIS_TTL_S = 7 * 24 * 3600;
const COST_VARIABLE_KEYS = /^(first|last|limit)$/i;

@Injectable()
export class CostHintStore {
  private readonly logger = new Logger(CostHintStore.name);
  private readonly local = new Map<string, CostHint>();

  constructor(private readonly redis: RedisService) {}

  static hash(query: string, variables?: unknown): string {
    const costVars: Record<string, unknown> = {};
    if (variables && typeof variables === 'object') {
      for (const [k, v] of Object.entries(variables as Record<string, unknown>)) {
        if (COST_VARIABLE_KEYS.test(k)) costVars[k] = v;
      }
    }
    return createHash('sha1')
      .update(query)
      .update('\n')
      .update(JSON.stringify(costVars))
      .digest('hex')
      .slice(0, 20);
  }

  /** The learned cost, or undefined if this query shape is new. */
  async get(query: string, variables?: unknown): Promise<number | undefined> {
    const h = CostHintStore.hash(query, variables);
    const hit = this.local.get(h);
    if (hit) {
      // Re-insert to keep it recent in the LRU.
      this.local.delete(h);
      this.local.set(h, hit);
      return Math.ceil(hit.req);
    }
    try {
      const remote = await this.redis.get<CostHint>(`rl:shopify:cost:${h}`);
      if (remote && remote.req > 0) {
        this.remember(h, remote);
        return Math.ceil(remote.req);
      }
    } catch {
      // Best-effort: fall through to the default.
    }
    return undefined;
  }

  /** Fold one observed `requestedQueryCost` into the estimate. */
  async learn(query: string, variables: unknown, requestedCost: number): Promise<void> {
    if (!Number.isFinite(requestedCost) || requestedCost <= 0) return;
    const h = CostHintStore.hash(query, variables);
    const prev = this.local.get(h);
    const next: CostHint = prev
      ? { req: prev.req * 0.7 + requestedCost * 0.3, n: prev.n + 1 }
      : { req: requestedCost, n: 1 };
    this.remember(h, next);

    // Write through only while the estimate is still moving, so a hot query
    // does not cost a Redis write per call for ever.
    const moved = !prev || Math.abs(next.req - prev.req) / prev.req > 0.05;
    if (next.n <= 3 || moved) {
      try {
        await this.redis.set(`rl:shopify:cost:${h}`, next, REDIS_TTL_S);
      } catch (err) {
        this.logger.debug(`cost hint write skipped: ${String(err)}`);
      }
    }
  }

  private remember(h: string, hint: CostHint): void {
    this.local.delete(h);
    this.local.set(h, hint);
    if (this.local.size > LRU_MAX) {
      // Map iterates in insertion order, so the first key is the least
      // recently used (get() re-inserts on every hit).
      for (const oldest of this.local.keys()) {
        this.local.delete(oldest);
        break;
      }
    }
  }
}
