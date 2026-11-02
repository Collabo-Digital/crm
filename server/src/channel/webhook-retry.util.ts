import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/library';
import { isRateLimitedError } from '../rate-limit/rate-limit.types';
import { ShopifyGraphqlError } from './shopify-graphql.client';

/// Prisma codes for a database that was briefly unreachable, slow or
/// contended: connection lost or timed out (P1001, P1002, P1008, P1017), pool
/// exhausted (P2024), interactive transaction expired (P2028), write conflict
/// or deadlock (P2034).
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);

/**
 * Would the same webhook succeed if Shopify delivered it again later?
 *
 * Only these failures are answered with a 5xx so Shopify retries. Anything
 * else (a payload this code cannot handle) is still acknowledged: it would
 * fail the same way on every retry, and Shopify removes a subscription whose
 * deliveries keep failing, which would stop that topic for the whole store.
 * Every handler is idempotent, so a retry after partial work is safe.
 */
export function isTransientWebhookError(err: unknown): boolean {
  if (isRateLimitedError(err)) return true;
  if (err instanceof PrismaClientInitializationError) return true;
  if (err instanceof PrismaClientKnownRequestError) {
    if (TRANSIENT_PRISMA_CODES.has(err.code)) return true;
    // Raw queries report serialization failures and deadlocks as P2010
    // carrying the Postgres SQLSTATE.
    if (err.code === 'P2010') {
      const sqlState = typeof err.meta?.code === 'string' ? err.meta.code : '';
      return sqlState === '40001' || sqlState === '40P01';
    }
    return false;
  }
  if (err instanceof ShopifyGraphqlError) {
    return (
      err.code === 'TIMEOUT' ||
      err.code === 'RETRY_EXHAUSTED' ||
      err.code === 'EMPTY_RESPONSE' ||
      (err.code === 'HTTP_ERROR' && (err.httpStatus ?? 0) >= 500)
    );
  }
  return false;
}
