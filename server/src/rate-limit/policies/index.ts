import { Priority, RateLimitScope } from '../rate-limit.types';

/**
 * The numbers one kind of wallet runs on. The Lua scripts are policy-free;
 * everything platform-specific is an ARGV built from one of these.
 */
export interface ScopePolicy {
  /// Bucket capacity when the wallet has never been seen.
  max: number;
  /// Refill per second when the wallet has never been seen.
  rate: number;
  /// Cost charged when the caller gives no hint. -1 means "use the learned
  /// percent-per-call stored on the wallet" (Meta usage windows).
  defaultCost: number;
  /// Cost used to seed a brand-new Meta wallet's `ppc`.
  defaultPpc: number;
  leaseTtlMs: number;
  keyTtlS: number;
  windowSeconds: number;
  breakerMinMs: number;
  breakerMaxMs: number;
  /// Fraction of `max` this priority must leave untouched.
  watermark(priority: Priority): number;
  /// How many requests of this priority may be in flight per wallet.
  inflightCap(priority: Priority): number;
  /// Translate the caller's cost into this wallet's units.
  costFor(scope: RateLimitScope, requested: number | undefined): number;
}

export interface PriorityTable {
  [Priority.INTERACTIVE]: number;
  [Priority.NORMAL]: number;
  [Priority.BULK]: number;
}

export const pick = (table: PriorityTable, p: Priority): number =>
  table[p as keyof PriorityTable] ?? table[Priority.NORMAL];

export interface ShopifyPolicyConfig {
  defaultCostHint: number;
  maximumAvailable: number;
  restoreRate: number;
  watermarks: PriorityTable;
  inflightCap: PriorityTable;
  leaseTtlMs: number;
  keyTtlS: number;
  breakerMinMs: number;
  breakerMaxMs: number;
}

export interface MetaPolicyConfig {
  watermarks: PriorityTable;
  inflightCap: PriorityTable;
  defaultPpc: number;
  phoneMps: number;
  windowSeconds: number;
  leaseTtlMs: number;
  keyTtlS: number;
  breakerMinMs: number;
  breakerMaxMs: number;
}

/**
 * Shopify's calculated-cost bucket, one per shop. Shopify itself calls it a
 * leaky bucket, but the mechanics — fixed capacity, constant refill, per-query
 * cost, bursts allowed up to capacity — are a token bucket, and every reply
 * carries the true balance so SETTLE can overwrite our estimate.
 */
export class TokenBucketPolicy implements ScopePolicy {
  readonly max: number;
  readonly rate: number;
  readonly defaultCost: number;
  readonly defaultPpc = 0;
  readonly leaseTtlMs: number;
  readonly keyTtlS: number;
  readonly windowSeconds = 1;
  readonly breakerMinMs: number;
  readonly breakerMaxMs: number;

  constructor(private readonly cfg: ShopifyPolicyConfig) {
    this.max = cfg.maximumAvailable;
    this.rate = cfg.restoreRate;
    this.defaultCost = cfg.defaultCostHint;
    this.leaseTtlMs = cfg.leaseTtlMs;
    this.keyTtlS = cfg.keyTtlS;
    this.breakerMinMs = cfg.breakerMinMs;
    this.breakerMaxMs = cfg.breakerMaxMs;
  }

  watermark(p: Priority): number {
    return pick(this.cfg.watermarks, p);
  }

  inflightCap(p: Priority): number {
    return pick(this.cfg.inflightCap, p);
  }

  costFor(_scope: RateLimitScope, requested: number | undefined): number {
    return requested && requested > 0 ? requested : this.defaultCost;
  }
}

/**
 * Meta's percentage windows (`X-App-Usage`, `X-Business-Use-Case-Usage`,
 * `X-Page-Usage`, `X-Ad-Account-Usage`), modelled as a bucket of 100 that
 * refills over the window. The cost of one call is learned per wallet from
 * successive percentages (OBSERVE); the phone-number wallet is a plain
 * messages-per-second bucket with cost 1 and no header.
 */
export class UsageWindowPolicy implements ScopePolicy {
  readonly max = 100;
  readonly rate: number;
  readonly defaultCost = -1;
  readonly defaultPpc: number;
  readonly leaseTtlMs: number;
  readonly keyTtlS: number;
  readonly windowSeconds: number;
  readonly breakerMinMs: number;
  readonly breakerMaxMs: number;

  constructor(private readonly cfg: MetaPolicyConfig) {
    this.windowSeconds = cfg.windowSeconds;
    this.rate = 100 / cfg.windowSeconds;
    this.defaultPpc = cfg.defaultPpc;
    this.leaseTtlMs = cfg.leaseTtlMs;
    this.keyTtlS = cfg.keyTtlS;
    this.breakerMinMs = cfg.breakerMinMs;
    this.breakerMaxMs = cfg.breakerMaxMs;
  }

  watermark(p: Priority): number {
    return pick(this.cfg.watermarks, p);
  }

  inflightCap(p: Priority): number {
    return pick(this.cfg.inflightCap, p);
  }

  /// -1 tells RESERVE to charge the wallet's learned percent-per-call.
  costFor(): number {
    return -1;
  }
}

/** WhatsApp per-phone-number throughput: N messages per second, cost 1 each. */
export class PhoneThroughputPolicy implements ScopePolicy {
  readonly max: number;
  readonly rate: number;
  readonly defaultCost = 1;
  readonly defaultPpc = 1;
  readonly leaseTtlMs: number;
  readonly keyTtlS: number;
  readonly windowSeconds = 1;
  readonly breakerMinMs: number;
  readonly breakerMaxMs: number;

  constructor(private readonly cfg: MetaPolicyConfig) {
    this.max = cfg.phoneMps;
    this.rate = cfg.phoneMps;
    this.leaseTtlMs = cfg.leaseTtlMs;
    this.keyTtlS = cfg.keyTtlS;
    this.breakerMinMs = cfg.breakerMinMs;
    this.breakerMaxMs = cfg.breakerMaxMs;
  }

  watermark(p: Priority): number {
    return pick(this.cfg.watermarks, p);
  }

  inflightCap(p: Priority): number {
    return pick(this.cfg.inflightCap, p);
  }

  costFor(): number {
    return 1;
  }
}

export interface PolicySet {
  shopify: TokenBucketPolicy;
  metaWindow: UsageWindowPolicy;
  metaPhone: PhoneThroughputPolicy;
}

export function policyFor(set: PolicySet, scope: RateLimitScope): ScopePolicy {
  if (scope.platform === 'shopify') return set.shopify;
  if (scope.kind === 'phone') return set.metaPhone;
  return set.metaWindow;
}
