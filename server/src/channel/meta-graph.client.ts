import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';
import {
  META_AUTH_CODE,
  META_TRANSIENT_CODES,
  MetaUsage,
  isMetaThrottleError,
  parseMetaUsageHeaders,
} from '../rate-limit/meta-usage-headers';
import { Priority, RateLimitedError, RateLimitScope, scopeKey } from '../rate-limit/rate-limit.types';
import {
  MetaErrorBody,
  MetaGraphError,
  MetaRequest,
  MetaResponse,
  metaScope,
} from './meta-graph.types';

const DEFAULT_TIMEOUT_MS = 15_000;
const TRANSIENT_RETRIES = 3;
const TRANSIENT_BACKOFF_MS = 1_000;

/**
 * The one door every Meta Graph API call goes through: WhatsApp Cloud API,
 * Instagram / Pages, and the Marketing API when it lands.
 *
 *  - Reserves from every wallet the call names BEFORE sending (app-level,
 *    business use case / ad account / page, phone number).
 *  - Reads every usage header on the way back and feeds each wallet its true
 *    percentage, so pacing is driven by Meta's own numbers.
 *  - Classifies Meta's error codes: 190 is a dead token, 4/17/32/613 and the
 *    WhatsApp / ads throughput subcodes open a breaker and surface as
 *    `RateLimitedError` (the queue parks the job), 1/2 and 5xx are retried
 *    with jitter, everything else is a `MetaGraphError` for the caller.
 *  - Tokens travel in the Authorization header, never the query string.
 */
@Injectable()
export class MetaGraphClient {
  private readonly logger = new Logger(MetaGraphClient.name);
  private readonly appId: string;
  private readonly graphVersion: string;

  constructor(
    private readonly config: ConfigService,
    private readonly limiter: RateLimiterService,
  ) {
    this.appId = this.config.get<string>('meta.appId') ?? '';
    this.graphVersion = this.config.get<string>('meta.graphVersion') ?? 'v21.0';
  }

  /** The app-level wallet every merchant shares. Empty id = unconfigured app. */
  appScope(): RateLimitScope | null {
    return this.appId ? metaScope.app(this.appId) : null;
  }

  /** `[app]` when the app id is known, else `[]` — for calls with no finer scope. */
  baseScopes(): RateLimitScope[] {
    const s = this.appScope();
    return s ? [s] : [];
  }

  graphUrl(path: string, version?: string): string {
    return `https://graph.facebook.com/${version ?? this.graphVersion}${path}`;
  }

  async request<T = unknown>(req: MetaRequest): Promise<MetaResponse<T>> {
    const url = new URL(req.url ?? this.graphUrl(req.path ?? '/', req.graphVersion));
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const priority = req.priority ?? Priority.NORMAL;
    const scopes = req.scopes;
    // Most specific wallet last, by convention; that is where a throttle
    // response opens its breaker.
    const specific = scopes[scopes.length - 1] ?? this.appScope();

    let transientLeft = TRANSIENT_RETRIES;
    for (;;) {
      const lease = await this.limiter.reserve(scopes, {
        priority,
        cost: 1,
        channelId: req.channelId,
      });
      let settled = false;
      // `spent` false = the call never reached Meta, give the reservation
      // back. true = deduct what was reserved (Meta reports no per-call
      // cost; the usage headers observed above correct any drift).
      const settle = async (spent: boolean) => {
        if (settled) return;
        settled = true;
        await this.limiter.settle(lease, spent ? {} : { actualCost: 0 }).catch(() => undefined);
      };

      try {
        let res: Response;
        try {
          res = await fetch(url, {
            method: req.method,
            headers: {
              ...(req.accessToken ? { Authorization: `Bearer ${req.accessToken}` } : {}),
              ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
            signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          });
        } catch (err) {
          await settle(false);
          const aborted =
            err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
          if (aborted) {
            throw new MetaGraphError(
              `Meta request ${req.method} ${url.pathname} timed out`,
              'TIMEOUT',
              undefined,
              undefined,
              undefined,
              err,
            );
          }
          throw err;
        }

        // Whether it succeeded or not, Meta told us how full the windows are.
        const usage = parseMetaUsageHeaders(res.headers, {
          appId: this.appId,
          pageId: req.pageId,
          adAccountId: req.adAccountId,
        });
        for (const u of usage) {
          await this.limiter
            .observe(u.scope, { pct: u.pct, regainMinutes: u.regainMinutes, callsSinceLast: 1 })
            .catch(() => undefined);
        }
        await settle(true);

        const body = (await res.json().catch(() => ({}))) as T & MetaErrorBody;
        const error = (body as MetaErrorBody).error;
        if (res.ok && !error) return { data: body as T, usage, status: res.status };

        const code = error?.code ?? res.status;
        const subcode = error?.error_subcode;
        const message = error?.message ?? `HTTP ${res.status}`;

        if (code === META_AUTH_CODE || res.status === 401) {
          throw new MetaGraphError(message, 'AUTH_FAILED', code, subcode, res.status, error);
        }

        if (isMetaThrottleError(code, subcode) || res.status === 429) {
          const hintMin = usage.find((u) => u.regainMinutes)?.regainMinutes;
          const retryAfterS = Number(res.headers.get('retry-after'));
          const hintMs = hintMin
            ? hintMin * 60_000
            : Number.isFinite(retryAfterS) && retryAfterS > 0
              ? retryAfterS * 1000
              : undefined;
          const scope = this.throttleScope(usage, specific);
          await this.limiter.recordThrottled(scope, {
            channelId: req.channelId,
            metaCode: code,
            subcode,
          });
          const until = await this.limiter.openBreaker(scope, {
            hintMs,
            reason: `META_${code}${subcode ? `_${subcode}` : ''}`,
            channelId: req.channelId,
          });
          throw new RateLimitedError(scope, until, 'BREAKER');
        }

        if (META_TRANSIENT_CODES.has(code) || res.status >= 500) {
          if (--transientLeft < 0) {
            throw new MetaGraphError(message, 'RETRY_EXHAUSTED', code, subcode, res.status, error);
          }
          const backoff = Math.floor(
            Math.random() * TRANSIENT_BACKOFF_MS * 2 ** (TRANSIENT_RETRIES - transientLeft - 1),
          );
          this.logger.warn(
            `Meta transient error ${code} on ${req.method} ${url.pathname}: retrying in ${backoff}ms (${transientLeft} left)`,
          );
          await new Promise((r) => setTimeout(r, Math.max(100, backoff)));
          continue;
        }

        if (!res.ok && !error) {
          throw new MetaGraphError(message, 'HTTP_ERROR', undefined, undefined, res.status, body);
        }
        throw new MetaGraphError(message, 'API_ERROR', code, subcode, res.status, error);
      } finally {
        await settle(false);
      }
    }
  }

  /**
   * Which wallet a throttle response is about. A BUC entry with a regain time
   * names the object Meta locked; failing that, an app-level header at 100%
   * points at the app; otherwise the most specific scope the caller passed.
   */
  private throttleScope(usage: MetaUsage[], fallback: RateLimitScope | null): RateLimitScope {
    const locked = usage.find((u) => u.regainMinutes);
    if (locked) return locked.scope;
    const appFull = usage.find((u) => u.scope.kind === 'app' && u.pct >= 100);
    if (appFull) return appFull.scope;
    if (fallback) return fallback;
    this.logger.warn('Throttled by Meta with no scope to attribute it to; using the app wallet.');
    return metaScope.app(this.appId || 'unknown');
  }

  /** For log lines: which wallets a request touched. */
  static describeScopes(scopes: RateLimitScope[]): string {
    return scopes.map(scopeKey).join(', ');
  }
}
