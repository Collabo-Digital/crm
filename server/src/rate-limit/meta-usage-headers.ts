import { RateLimitScope } from './rate-limit.types';

/**
 * Pure parser for Meta Graph API usage headers. No Redis, no HTTP: give it the
 * response headers, get back "these wallets are at these percentages".
 *
 *   X-App-Usage                {"call_count":28,"total_cputime":25,"total_time":25}
 *   X-Business-Use-Case-Usage  {"<businessId>":[{"type":"whatsapp","call_count":..,
 *                               "total_cputime":..,"total_time":..,
 *                               "estimated_time_to_regain_access":0}]}
 *   X-Ad-Account-Usage         {"acc_id_util_pct":9.67}
 *   X-Page-Usage               {"call_count":..,"total_cputime":..,"total_time":..}
 *
 * Meta enforces on whichever of the three metrics is highest, so that is the
 * percentage we track.
 */
export interface MetaUsage {
  scope: RateLimitScope;
  /// 0..100
  pct: number;
  /// Minutes until access returns, when Meta has locked the object.
  regainMinutes?: number;
  /// The `type` field from a BUC entry (whatsapp, ads_management, ...).
  type?: string;
}

/// Codes Meta uses for "slow down". 4 = app, 17 = user, 32 = page, 613 = custom.
export const META_THROTTLE_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);

/// Subcodes for the same, from the WhatsApp Cloud API and Marketing API:
/// 80004/80007 ads throughput, 130429 WhatsApp rate limit, 131048 spam rate
/// limit, 131056 pair rate limit.
export const META_THROTTLE_SUBCODES: ReadonlySet<number> = new Set([
  80004, 80007, 130429, 131048, 131056,
]);

export function isMetaThrottleError(code?: number, subcode?: number): boolean {
  return (
    (code !== undefined && META_THROTTLE_CODES.has(code)) ||
    (subcode !== undefined && META_THROTTLE_SUBCODES.has(subcode)) ||
    (code !== undefined && META_THROTTLE_SUBCODES.has(code))
  );
}

/// Meta's "temporary issue, try again" code.
export const META_TRANSIENT_CODES: ReadonlySet<number> = new Set([1, 2]);
/// Token invalid / expired / revoked.
export const META_AUTH_CODE = 190;

const AD_ACCOUNT_TYPES = new Set(['ads_management', 'ads_insights', 'custom_audience']);

function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pctOf(o: unknown): number {
  if (!o || typeof o !== 'object') return 0;
  const r = o as Record<string, unknown>;
  const nums = [r.call_count, r.total_cputime, r.total_time, r.acc_id_util_pct]
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v));
  if (nums.length === 0) return 0;
  return Math.max(0, Math.min(100, Math.max(...nums)));
}

function regainOf(o: unknown): number | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const v = (o as Record<string, unknown>).estimated_time_to_regain_access;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface MetaHeaderContext {
  /// Our Meta app id, because X-App-Usage does not name the app.
  appId: string;
  /// Page id when the request targeted a page (X-Page-Usage does not name it).
  pageId?: string;
  /// Ad account id when known (X-Ad-Account-Usage does not name it either).
  adAccountId?: string;
}

/**
 * Parse every usage header present. Missing or malformed headers are simply
 * skipped — a parser failure must never fail a request.
 */
export function parseMetaUsageHeaders(
  headers: Headers | Record<string, string | null | undefined>,
  ctx: MetaHeaderContext,
): MetaUsage[] {
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name);
    }
    const rec = headers as Record<string, string | null | undefined>;
    return rec[name] ?? rec[name.toLowerCase()] ?? null;
  };

  const out: MetaUsage[] = [];

  const app = safeJson(get('x-app-usage'));
  if (app && ctx.appId) {
    out.push({ scope: { platform: 'meta', kind: 'app', id: ctx.appId }, pct: pctOf(app) });
  }

  const buc = safeJson(get('x-business-use-case-usage'));
  if (buc && typeof buc === 'object') {
    for (const [id, entries] of Object.entries(buc as Record<string, unknown>)) {
      const list = Array.isArray(entries) ? entries : [entries];
      for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const rawType = (e as Record<string, unknown>).type;
        const type = typeof rawType === 'string' ? rawType : '';
        out.push({
          scope: { platform: 'meta', kind: AD_ACCOUNT_TYPES.has(type) ? 'adacct' : 'buc', id },
          pct: pctOf(e),
          regainMinutes: regainOf(e),
          type: type || undefined,
        });
      }
    }
  }

  const adacct = safeJson(get('x-ad-account-usage'));
  if (adacct && ctx.adAccountId) {
    out.push({
      scope: { platform: 'meta', kind: 'adacct', id: ctx.adAccountId },
      pct: pctOf(adacct),
      regainMinutes: regainOf(adacct),
    });
  }

  const page = safeJson(get('x-page-usage'));
  if (page && ctx.pageId) {
    out.push({ scope: { platform: 'meta', kind: 'page', id: ctx.pageId }, pct: pctOf(page) });
  }

  return out;
}
