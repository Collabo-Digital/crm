import { Priority, RateLimitScope } from '../rate-limit/rate-limit.types';
import type { MetaUsage } from '../rate-limit/meta-usage-headers';

export type MetaGraphErrorCode =
  | 'AUTH_FAILED'
  | 'TRANSIENT'
  | 'API_ERROR'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'RETRY_EXHAUSTED';

/**
 * Thrown by `MetaGraphClient` for everything except a rate limit (which is a
 * `RateLimitedError` so queue processors park uniformly). `metaCode` and
 * `subcode` carry Meta's own error numbers; `details` the raw error object.
 */
export class MetaGraphError extends Error {
  constructor(
    message: string,
    public readonly code: MetaGraphErrorCode,
    public readonly metaCode?: number,
    public readonly subcode?: number,
    public readonly httpStatus?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MetaGraphError';
  }
}

export interface MetaRequest {
  method: 'GET' | 'POST' | 'DELETE';
  /// Path under the versioned Graph base, e.g. `/123/messages`.
  path?: string;
  /// Absolute URL instead of `path` — for Meta's `paging.next` links.
  url?: string;
  /// Sent as `Authorization: Bearer`, never in the query string. Optional
  /// only for the OAuth code-exchange endpoints, which take client_secret
  /// as a query parameter instead.
  accessToken?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /// Wallets this call draws from, broad to specific: app, then business
  /// use case / ad account / page, then phone number.
  scopes: RateLimitScope[];
  priority?: Priority;
  channelId?: string;
  timeoutMs?: number;
  graphVersion?: string;
  /// Ids the usage headers do not carry themselves.
  pageId?: string;
  adAccountId?: string;
}

export interface MetaResponse<T> {
  data: T;
  usage: MetaUsage[];
  status: number;
}

export interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

/** Scope builders so callers never spell a wallet by hand. */
export const metaScope = {
  app: (appId: string): RateLimitScope => ({ platform: 'meta', kind: 'app', id: appId }),
  /// Business use case: a WhatsApp business account, Instagram messaging...
  buc: (id: string): RateLimitScope => ({ platform: 'meta', kind: 'buc', id }),
  phone: (phoneNumberId: string): RateLimitScope => ({ platform: 'meta', kind: 'phone', id: phoneNumberId }),
  page: (pageId: string): RateLimitScope => ({ platform: 'meta', kind: 'page', id: pageId }),
  adAccount: (actId: string): RateLimitScope => ({ platform: 'meta', kind: 'adacct', id: actId }),
};
