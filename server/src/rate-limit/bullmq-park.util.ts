import { Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { isRateLimitedError, scopeKey } from './rate-limit.types';

/**
 * Turn a `RateLimitedError` into a parked job.
 *
 * Call from a processor's `catch`. A rate limit is not a failure: the job is
 * moved to the delayed set until the limiter said it makes sense to retry,
 * and `DelayedError` tells BullMQ "I moved it myself" so `attemptsMade` does
 * not increase and no `failed` event fires. Anything else is rethrown so the
 * normal failure path runs.
 *
 * Needs the worker `token` that `WorkerHost.process(job, token)` receives —
 * `moveToDelayed` refuses without it. If a caller has no token (tests, odd
 * dispatch paths) the error is rethrown and BullMQ's ordinary backoff applies.
 */
export async function parkIfRateLimited(
  err: unknown,
  job: Job,
  token: string | undefined,
  logger: Logger,
): Promise<never> {
  if (isRateLimitedError(err) && token) {
    // Small jitter so twenty parked jobs do not all wake in the same tick.
    const at = Math.max(Date.now() + 250, err.retryAtMs) + Math.floor(Math.random() * 2000);
    logger.warn(
      JSON.stringify({
        event: 'rate_limit.job_parked',
        jobId: job.id,
        name: job.name,
        scope: scopeKey(err.scope),
        reason: err.reason,
        retryAt: new Date(at).toISOString(),
        attemptsMade: job.attemptsMade,
      }),
    );
    await job.moveToDelayed(at, token);
    throw new DelayedError();
  }
  throw err;
}
