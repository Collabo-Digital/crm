import { Logger } from '@nestjs/common';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { parkIfRateLimited } from './bullmq-park.util';
import { Priority, RateLimitedError } from './rate-limit.types';

/**
 * The fairness half, against a real BullMQ on real Redis.
 *
 * The unit specs prove the enqueuer sets a priority on every add and that the
 * processor parks a rate-limited job. These two prove BullMQ then does what we
 * are relying on it to do: run the user's click before a queued backfill, and
 * treat a parked job as delayed rather than failed.
 *
 * Runs on its own throwaway queue name, so it never touches `shopify-push`.
 * Guarded by RATE_LIMIT_IT_REDIS_URL like the other integration spec:
 *   RATE_LIMIT_IT_REDIS_URL=$REDIS_URL npx jest queue-fairness --forceExit
 * `--forceExit` because BullMQ keeps its Redis connections alive briefly after
 * close; the assertions have all run by then.
 */
const IT_URL = process.env.RATE_LIMIT_IT_REDIS_URL;
const describeIfRedis = IT_URL ? describe : describe.skip;

const BULK_JOBS = 15;

describeIfRedis('queue fairness and parking, real BullMQ', () => {
  const logger = new Logger('fairness-test');
  let name: string;
  let connection: { url: string };
  let queue: Queue;
  /** Closed in afterEach — never from inside a job, which deadlocks. */
  let workers: Worker[] = [];
  let events: QueueEvents[] = [];

  beforeEach(async () => {
    name = `rl-fairness-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    connection = { url: IT_URL! };
    workers = [];
    events = [];
    queue = new Queue(name, { connection });
    await queue.waitUntilReady();
  });

  afterEach(async () => {
    for (const w of workers) await w.close().catch(() => undefined);
    for (const e of events) await e.close().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  function startWorker(fn: (job: Job, token?: string) => Promise<void>): Worker {
    const w = new Worker(name, fn, { connection, concurrency: 1 });
    workers.push(w);
    return w;
  }

  /** Reject loudly instead of dying to an opaque jest timeout. */
  function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms)),
    ]);
  }

  it(
    "runs a user's click before a backfill that was queued long before it",
    async () => {
      // Bulk jobs first, then ONE interactive job last. Under plain FIFO the
      // interactive job would run last — the head-of-line blocking that made a
      // merchant's order push wait behind another tenant's whole catalogue.
      await queue.addBulk(
        Array.from({ length: BULK_JOBS }, (_, i) => ({
          name: 'push-product',
          data: { kind: 'bulk', i },
          opts: { priority: Priority.BULK, removeOnComplete: true },
        })),
      );
      await queue.add(
        'push-order',
        { kind: 'interactive' },
        { priority: Priority.INTERACTIVE, removeOnComplete: true },
      );

      const order: string[] = [];
      const allDone = new Promise<void>((resolve) => {
        startWorker((job: Job<{ kind: string }>) => {
          order.push(job.data.kind);
          if (order.length === BULK_JOBS + 1) resolve();
          return Promise.resolve();
        });
      });

      await within(allDone, 55_000, 'all jobs to be processed');

      expect(order).toHaveLength(BULK_JOBS + 1);
      expect(order[0]).toBe('interactive'); // added last, run first
      expect(order.slice(1).every((k) => k === 'bulk')).toBe(true);
    },
    60_000,
  );

  it(
    'parks a rate-limited job as delayed, with its attempt count untouched',
    async () => {
      const added = await queue.add(
        'push-order',
        { kind: 'interactive' },
        { priority: Priority.INTERACTIVE, attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
      );

      const qe = new QueueEvents(name, { connection });
      events.push(qe);
      await qe.waitUntilReady();

      const settled = new Promise<string>((resolve) => {
        qe.once('delayed', ({ jobId }) => resolve(`delayed:${jobId}`));
        qe.once('failed', ({ jobId }) => resolve(`failed:${jobId}`));
      });

      const retryAt = Date.now() + 120_000;
      startWorker(async (job: Job, token?: string) => {
        // Exactly what the processors do when the limiter says wait.
        await parkIfRateLimited(
          new RateLimitedError({ platform: 'shopify', kind: 'bucket', id: 'shop-a' }, retryAt, 'BREAKER'),
          job,
          token,
          logger,
        );
      });

      const outcome = await within(settled, 30_000, 'the job to be delayed or failed');
      expect(outcome).toBe(`delayed:${added.id!}`); // a throttle is not a failure

      const job = await queue.getJob(added.id!);
      expect(await job!.getState()).toBe('delayed');
      expect(job!.attemptsMade).toBe(0); // no retry burned
    },
    60_000,
  );
});
