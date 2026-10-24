import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

/**
 * Bounded retry for sequential-numbering collisions.
 *
 * Read-max-then-increment numbering (order numbers, invoice numbers) can lose
 * a race two ways under concurrency:
 *
 *   P2034 — Postgres aborted one Serializable transaction (SQLSTATE 40001).
 *   P2002 — both transactions committed the read and the unique index caught
 *           the duplicate on write.
 *
 * Both are transient: the loser only has to re-read the max and take the next
 * number. Prisma does NOT retry either on its own, so callers must.
 *
 * P2002 is only retried when the caller's `isRetriableUniqueViolation`
 * predicate matches, so an unrelated unique violation (a duplicate customer
 * email, say) still fails fast instead of being retried into the same error.
 *
 * The retried work must be a single transaction that allocates its number
 * inside itself — a rolled-back attempt then consumes nothing and re-running
 * it is side-effect free.
 *
 * Each retry waits a random time that doubles per attempt. Postgres lets one
 * of N concurrent numbering transactions commit per round, so a burst (a sale
 * spike of paid-order webhooks, each auto-invoicing) retried in lockstep
 * collided again every time and three immediate attempts left paid orders
 * uninvoiced. The jitter spreads the losers out.
 */
export async function retryOnNumberingConflict<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    /** First retry waits up to this long; each later one up to twice the last. */
    baseDelayMs?: number;
    isRetriableUniqueViolation: (e: PrismaClientKnownRequestError) => boolean;
    onRetry?: (attempt: number, error: PrismaClientKnownRequestError) => void;
  },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 8;
  const baseDelayMs = opts.baseDelayMs ?? 25;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (
        attempt >= maxAttempts ||
        !(err instanceof PrismaClientKnownRequestError) ||
        !isRetriable(err, opts.isRetriableUniqueViolation)
      ) {
        throw err;
      }
      opts.onRetry?.(attempt, err);
      const ceiling = Math.min(baseDelayMs * 2 ** (attempt - 1), 1_000);
      if (ceiling > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
      }
    }
  }
}

function isRetriable(
  err: PrismaClientKnownRequestError,
  isRetriableUniqueViolation: (e: PrismaClientKnownRequestError) => boolean,
): boolean {
  if (err.code === 'P2034') return true;
  // Raw queries ($queryRaw/$executeRaw) bypass the P2034 mapping: Prisma
  // reports them as P2010 carrying the Postgres SQLSTATE. 40001 is
  // serialization_failure, 40P01 is deadlock_detected — both transient.
  if (err.code === 'P2010') {
    const sqlState = String(err.meta?.code ?? '');
    return sqlState === '40001' || sqlState === '40P01';
  }
  return err.code === 'P2002' && isRetriableUniqueViolation(err);
}

/**
 * True when a P2002 came from a unique index covering `field`. Prisma reports
 * `meta.target` as either the model's field names or the raw index name
 * depending on the connector, so match both spellings (`orderNumber`,
 * `order_number`).
 */
export function uniqueViolationTargets(
  err: PrismaClientKnownRequestError,
  field: string,
): boolean {
  const target = err.meta?.target;
  const asText = Array.isArray(target) ? target.join(',') : String(target ?? '');
  const snakeCase = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return asText.includes(field) || asText.includes(snakeCase);
}
