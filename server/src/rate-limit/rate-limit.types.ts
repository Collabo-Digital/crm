/**
 * Vocabulary shared by every part of the outbound rate limiter.
 *
 * Nothing in here touches Redis, Shopify or Meta. If a new priority level or a
 * new kind of wallet is ever needed, it is added here and the compiler points
 * at every place that has to learn the new word.
 */

/// How urgent a request is. The numbers double as BullMQ job priorities, where
/// SMALLER runs first, and select the watermark / in-flight cap in the limiter.
/// Gaps are deliberate so a level can be added later without renumbering.
export enum Priority {
  /// A person is waiting: a user clicked Sync, edited an order, a customer is
  /// owed a WhatsApp confirmation.
  INTERACTIVE = 1,
  /// Should happen soon, nobody is watching: a webhook arrived, one product
  /// changed.
  NORMAL = 5,
  /// Can take all night: backfills, catalogue pushes, the analytics cron.
  BULK = 10,
}

export type RateLimitPlatform = 'shopify' | 'meta';

/// Which sort of wallet inside a platform. Shopify has one (the shop's cost
/// bucket). Meta limits at the app level, per business use case (WhatsApp
/// business account, Instagram messaging...), per phone number, per ad account
/// and per page — and one request may draw from several at once.
export type RateLimitScopeKind = 'bucket' | 'app' | 'buc' | 'phone' | 'adacct' | 'page';

/// The address of one wallet.
export interface RateLimitScope {
  platform: RateLimitPlatform;
  kind: RateLimitScopeKind;
  /// Shop domain, phone number id, ad account id, app id...
  id: string;
}

/// The one place the Redis key for a wallet is spelled.
export const scopeKey = (s: RateLimitScope): string => `rl:${s.platform}:${s.kind}:${s.id}`;

export type DenyReason = 'BUCKET' | 'INFLIGHT' | 'BREAKER';
export type ReserveReason = 'OK' | DenyReason;

/// Raw answer from one RESERVE script call. Internal to the service.
export interface ReserveDecision {
  scope: RateLimitScope;
  allowed: boolean;
  waitMs: number;
  reason: ReserveReason;
  leaseId: string;
  /// The cost the script actually charged (Meta wallets learn it per call).
  cost: number;
  /// Spendable balance after this reservation, for logging.
  available?: number;
}

/// The receipt handed out by `reserve()` and returned by `settle()`.
export interface Lease {
  /// One per scope, same order as `scopes`. Empty for a noop lease.
  leaseIds: string[];
  scopes: RateLimitScope[];
  /// Cost charged per scope, same order as `scopes`.
  costs: number[];
  priority: Priority;
  channelId?: string;
  /// True when the limiter is off / observing: nothing was reserved, so
  /// `settle()` has nothing to close.
  noop: boolean;
}

/// A platform's own statement of the wallet balance (Shopify's throttleStatus).
export interface Observation {
  available: number;
  max: number;
  rate: number;
  /// Epoch ms the observation was taken, so out-of-order replies are ignored.
  at: number;
}

/// Meta's statement of a wallet: a percentage used, plus an optional lockout.
export interface MetaObservation {
  /// 0..100, the highest of call_count / total_cputime / total_time.
  pct: number;
  windowSeconds?: number;
  /// `estimated_time_to_regain_access` from the BUC header, in minutes.
  regainMinutes?: number;
  /// How many calls this process made on the scope since the last observation
  /// — the denominator for learning percent-per-call.
  callsSinceLast?: number;
}

export type RateLimitMode = 'enforce' | 'observe' | 'off';

/// What callers pass into the clients. Everything optional so existing call
/// sites compile untouched.
export interface RateLimitOptions {
  priority?: Priority;
  costHint?: number;
  channelId?: string;
}

/**
 * Thrown by `reserve()` when a request must not go out now and the wait is
 * too long to sleep through in-process. Queue processors turn it into a
 * delayed job (`parkIfRateLimited`); the HTTP filter turns it into a 503.
 */
export class RateLimitedError extends Error {
  constructor(
    public readonly scope: RateLimitScope,
    /// Earliest sensible moment to try again, epoch ms.
    public readonly retryAtMs: number,
    public readonly reason: DenyReason,
  ) {
    super(
      `Rate limited on ${scopeKey(scope)} until ${new Date(retryAtMs).toISOString()} (${reason})`,
    );
    this.name = 'RateLimitedError';
  }
}

/// `instanceof` plus a name check, so an error that crossed a module boundary
/// (or was re-created by a serialiser) is still recognised.
export function isRateLimitedError(err: unknown): err is RateLimitedError {
  return (
    err instanceof RateLimitedError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: string }).name === 'RateLimitedError' &&
      typeof (err as { retryAtMs?: unknown }).retryAtMs === 'number')
  );
}
