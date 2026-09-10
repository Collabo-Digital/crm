import { Injectable } from '@nestjs/common';

/**
 * In-process stand-in for the Redis scripts, used ONLY while Redis is
 * unreachable or slow (see `RateLimiterService.run`).
 *
 * It is deliberately crude: one bucket per key, seeded from the last real
 * observation this process saw, plus a small per-key semaphore. Being roughly
 * right for ten seconds is the goal — never blocking a request because the
 * limiter's own storage hiccupped is the requirement.
 */
interface LocalBucket {
  avail: number;
  max: number;
  rate: number;
  at: number;
  reserved: number;
  inflight: number;
  breakerUntil: number;
}

const SEMAPHORE = 2;

@Injectable()
export class LocalFallbackLimiter {
  private readonly buckets = new Map<string, LocalBucket>();

  /** Called by the service whenever a real observation goes by, so the
   *  fallback starts from the truth rather than from "full". */
  seed(bucketKey: string, obs: { available: number; max: number; rate: number; at: number }): void {
    const b = this.get(bucketKey, obs.max, obs.rate);
    b.avail = obs.available;
    b.max = obs.max;
    b.rate = obs.rate;
    b.at = obs.at;
  }

  run(name: string, keys: string[], args: unknown[]): unknown {
    switch (name) {
      case 'rlReserve':
        return this.reserve(keys[0], args);
      case 'rlSettle':
        return this.settle(keys[0], Number(args[2]), Number(args[3]));
      case 'rlRelease':
        return this.settle(keys[0], Number(args[1]), 0);
      case 'rlObserve': {
        const b = this.get(keys[0], 100, 100 / Number(args[2] || 3600));
        b.avail = 100 - Number(args[1]);
        b.max = 100;
        b.rate = 100 / Number(args[2] || 3600);
        b.at = Number(args[0]);
        return '0.5';
      }
      case 'rlBreakerOpen': {
        const b = this.get(keys[0], 1, 1);
        const hint = Number(args[3]);
        const dur = hint > 0 ? hint : Number(args[1]);
        b.breakerUntil = Number(args[0]) + dur;
        return String(b.breakerUntil);
      }
      default:
        return 1;
    }
  }

  private reserve(key: string, args: unknown[]): unknown[] {
    const now = Number(args[0]);
    let cost = Number(args[1]);
    const defMax = Number(args[4]);
    const defRate = Number(args[5]);
    const watermark = Number(args[6]);
    const defCost = Number(args[10] ?? 1);
    if (cost < 0) cost = defCost;

    const b = this.get(key, defMax, defRate);
    if (b.breakerUntil > now) return [0, b.breakerUntil - now, 'BREAKER', 0, String(cost)];

    if (now > b.at) {
      b.avail = Math.min(b.max, b.avail + ((now - b.at) / 1000) * b.rate);
      b.at = now;
    }
    const effective = b.avail - b.reserved;
    const floor = b.max * watermark;
    if (effective - cost < floor) {
      const waitMs = b.rate > 0 ? Math.max(50, Math.ceil(((floor + cost - effective) / b.rate) * 1000)) : 50;
      return [0, waitMs, 'BUCKET', 0, String(cost)];
    }
    if (b.inflight >= SEMAPHORE) return [0, 250, 'INFLIGHT', 0, String(cost)];

    b.reserved += cost;
    b.inflight += 1;
    return [1, 0, 'OK', Math.floor(effective - cost), String(cost)];
  }

  private settle(key: string, reservedCost: number, actualCost: number): number {
    const b = this.buckets.get(key);
    if (!b) return 1;
    b.reserved = Math.max(0, b.reserved - reservedCost);
    b.inflight = Math.max(0, b.inflight - 1);
    const spent = actualCost >= 0 ? actualCost : reservedCost;
    if (spent > 0) b.avail -= spent;
    return 1;
  }

  private get(key: string, max: number, rate: number): LocalBucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { avail: max, max, rate, at: Date.now(), reserved: 0, inflight: 0, breakerUntil: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }
}
