import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import configuration from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { RateLimitModule } from './rate-limit.module';
import { RateLimiterService } from './rate-limiter.service';
import { ShopifyGraphqlClient } from '../channel/shopify-graphql.client';
import { Priority, RateLimitScope, isRateLimitedError, scopeKey } from './rate-limit.types';

/**
 * End-to-end through the REAL wiring: the real ShopifyGraphqlClient, the real
 * RateLimiterService, the real Lua inside a real Redis. The only stand-in is
 * the shop itself — and it is not a rubber stamp: `FakeShop` keeps its own
 * leaky bucket and answers THROTTLED whenever it is asked to spend more than
 * it holds, exactly as Shopify would.
 *
 * That makes the headline assertion meaningful: under load the limiter must
 * pace us so the shop never has to refuse. The last test switches the limiter
 * off and shows the same load being refused, so the assertion is not vacuous.
 *
 * Guarded: runs only when RATE_LIMIT_IT_REDIS_URL is set, e.g.
 *   RATE_LIMIT_IT_REDIS_URL=$REDIS_URL npx jest rate-limit.integration
 */
const IT_URL = process.env.RATE_LIMIT_IT_REDIS_URL;
const describeIfRedis = IT_URL ? describe : describe.skip;

/** A Shopify shop's calculated-cost bucket, as Shopify actually runs it. */
class FakeShop {
  private avail: number;
  private at = Date.now();
  /** Times the shop had to refuse us. The number that must stay at 0. */
  throttles = 0;
  /** Requests it accepted. */
  served = 0;

  constructor(
    private readonly max = 1000,
    private readonly restoreRate = 50,
    start = max,
  ) {
    this.avail = start;
  }

  private refill(): void {
    const now = Date.now();
    this.avail = Math.min(this.max, this.avail + ((now - this.at) / 1000) * this.restoreRate);
    this.at = now;
  }

  /** Mirrors Shopify: charge the query, or refuse with THROTTLED. */
  handle(cost: number): Response {
    this.refill();
    if (this.avail < cost) {
      this.throttles++;
      return new Response(
        JSON.stringify({
          errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
          extensions: { cost: { requestedQueryCost: cost, actualQueryCost: 0, throttleStatus: this.status() } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    this.avail -= cost;
    this.served++;
    return new Response(
      JSON.stringify({
        data: { ok: true },
        extensions: { cost: { requestedQueryCost: cost, actualQueryCost: cost, throttleStatus: this.status() } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  private status() {
    return {
      maximumAvailable: this.max,
      currentlyAvailable: Math.floor(this.avail),
      restoreRate: this.restoreRate,
    };
  }
}

describeIfRedis('rate limiter, end to end against real Redis', () => {
  let moduleRef: TestingModule;
  let limiter: RateLimiterService;
  let client: ShopifyGraphqlClient;
  let redis: RedisService;
  let shop: string;
  let scope: RateLimitScope;
  let query: string;
  const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.REDIS_URL = IT_URL;
    process.env.RATE_LIMIT_MODE = 'enforce';
    // These cases assert on exact wallet arithmetic, so give Redis room: a
    // single slow round trip would legitimately fail open and send the request
    // unmetered, which would look like a limiter bug here. Fail-open itself has
    // its own case at the bottom of this file, and the unit spec covers the
    // consecutive-failure threshold.
    process.env.RATE_LIMIT_REDIS_TIMEOUT_MS = '5000';
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
        PrismaModule,
        RedisModule,
        RateLimitModule,
      ],
      providers: [ShopifyGraphqlClient],
    }).compile();
    await moduleRef.init();
    limiter = moduleRef.get(RateLimiterService);
    client = moduleRef.get(ShopifyGraphqlClient);
    redis = moduleRef.get(RedisService);
    expect(moduleRef.get(ConfigService).get('rateLimit.mode')).toBe('enforce');
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await moduleRef?.close();
  });

  beforeEach(() => {
    // A fresh shop and a distinct query text per test: no wallet or learned-cost
    // bleed between cases.
    const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    shop = `it-${tag}.myshopify.com`;
    scope = { platform: 'shopify', kind: 'bucket', id: shop };
    query = `query Probe_${tag.replace(/-/g, '_')} { shop { name } }`;
  });

  afterEach(async () => {
    for (const k of [
      scopeKey(scope),
      `rl:lease:shopify:bucket:${shop}`,
      `rl:inflight:shopify:bucket:${shop}`,
      `rl:breaker:shopify:bucket:${shop}`,
    ]) {
      await redis.del(k);
    }
  });

  /** Seed the wallet as if Shopify had just reported this balance. */
  async function seedWallet(available: number): Promise<void> {
    const lease = await limiter.reserve([scope], { priority: Priority.INTERACTIVE, cost: 0 });
    await limiter.settle(lease, {
      actualCost: 0,
      observation: { available, max: 1000, rate: 50, at: Date.now() },
    });
  }

  function serve(fake: FakeShop, costPerCall: number): void {
    global.fetch = jest.fn(() => Promise.resolve(fake.handle(costPerCall))) as unknown as typeof fetch;
  }

  const auth = () => ({ shopDomain: shop, accessToken: 't', channelId: 'ch-it' });

  it(
    'paces a burst so the shop never has to refuse a single request',
    async () => {
      const fake = new FakeShop(1000, 50, 1000);
      serve(fake, 100);

      // 14 bulk calls at 100 points against a 1000-point bucket: far more than
      // it holds at once, so only correct pacing keeps the shop from refusing.
      const results = await Promise.allSettled(
        Array.from({ length: 14 }, () =>
          client.request(auth(), query, undefined, undefined, { priority: Priority.BULK, costHint: 100 }),
        ),
      );
      const sent = results.filter((r) => r.status === 'fulfilled').length;
      const parked = results.filter((r) => r.status === 'rejected' && isRateLimitedError(r.reason)).length;
      const broke = results.filter((r) => r.status === 'rejected' && !isRateLimitedError(r.reason));

      expect(broke).toEqual([]); // nothing failed for a real reason
      expect(sent + parked).toBe(14); // every call either went out or was parked
      expect(sent).toBe(fake.served);
      expect(fake.throttles).toBe(0); // THE POINT: the shop never had to say no

      // And the wallet is left clean: no leaked reservation, no stuck slot.
      const state = await limiter.getState(scope);
      expect(Number(state.bucket.reserved)).toBe(0);
      expect(Number(state.inflight.p10 ?? 0)).toBe(0);
      expect(Number(state.today.throttled ?? 0)).toBe(0);
    },
    60_000,
  );

  it(
    'without the limiter the same burst does get refused (the test above is not vacuous)',
    async () => {
      const fake = new FakeShop(1000, 50, 1000);
      serve(fake, 100);
      // `off` is the kill switch: no reservations, everything goes at once.
      jest.spyOn(limiter, 'mode').mockReturnValue('off');

      await Promise.allSettled(
        Array.from({ length: 14 }, () =>
          client.request(auth(), query, undefined, undefined, { priority: Priority.BULK, costHint: 100 }),
        ),
      );

      expect(fake.throttles).toBeGreaterThan(0);
      jest.restoreAllMocks();
    },
    60_000,
  );

  it(
    'holds bulk work back at its floor while a user-facing call goes straight through',
    async () => {
      // 250 points. Bulk may not go below 300, so a 100-point bulk call must
      // wait (300 + 100 - 250) / 50 = 3s — comfortably past its 2s budget, so
      // it parks rather than sleeping. Interactive may spend down to 50, so it
      // goes immediately. The margin matters: seeding near the boundary (305
      // gives a 1.9s wait) lets the limiter legitimately sleep it out instead,
      // which is correct behaviour but not what this case is about.
      await seedWallet(250);
      const fake = new FakeShop(1000, 50, 250);
      serve(fake, 100);

      const refused: unknown = await client
        .request(auth(), query, undefined, undefined, { priority: Priority.BULK, costHint: 100 })
        .catch((e: unknown) => e);
      expect(isRateLimitedError(refused)).toBe(true);
      expect(fake.served).toBe(0); // it never even reached the shop

      await expect(
        client.request(auth(), query, undefined, undefined, { priority: Priority.INTERACTIVE, costHint: 100 }),
      ).resolves.toEqual({ ok: true });
      expect(fake.served).toBe(1);
      expect(fake.throttles).toBe(0);
    },
    30_000,
  );

  it(
    'a real 429 shuts the door for every priority until the cooldown passes',
    async () => {
      await seedWallet(1000);
      global.fetch = jest.fn(() =>
        Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '1' } })),
      ) as unknown as typeof fetch;

      await expect(
        client.request(auth(), query, undefined, undefined, { costHint: 10 }),
      ).rejects.toBeDefined();

      const open = await limiter.getState(scope);
      expect(open.breaker).not.toBeNull();
      expect(open.breaker?.reason).toBe('HTTP_429');
      expect(Number(open.today.throttled)).toBeGreaterThan(0);

      // Even an interactive caller is refused while the cooldown runs.
      const blocked: unknown = await limiter
        .reserve([scope], { priority: Priority.INTERACTIVE, cost: 1 })
        .catch((e: unknown) => e);
      expect(isRateLimitedError(blocked)).toBe(true);

      await limiter.closeBreaker(scope);
      await expect(
        limiter.reserve([scope], { priority: Priority.INTERACTIVE, cost: 1 }),
      ).resolves.toMatchObject({ noop: false });
    },
    60_000,
  );

  it("resyncs the wallet to Shopify's own number on every reply", async () => {
    await seedWallet(1000);
    const fake = new FakeShop(1000, 50, 1000);
    serve(fake, 387);

    await client.request(auth(), query, undefined, undefined, { costHint: 50 });

    const state = await limiter.getState(scope);
    // The shop charged 387 and reported 613; our 50-point estimate is discarded.
    expect(Number(state.bucket.avail)).toBe(613);
    expect(Number(state.bucket.reserved)).toBe(0);
  });

  it('lets requests through when Redis itself is unreachable', async () => {
    const spy = jest
      .spyOn(redis, 'runScript')
      .mockRejectedValue(new Error('ECONNREFUSED (simulated Redis outage)'));
    const fake = new FakeShop();
    serve(fake, 10);

    await expect(
      client.request(auth(), query, undefined, undefined, { costHint: 50 }),
    ).resolves.toEqual({ ok: true });
    expect(fake.served).toBe(1);

    spy.mockRestore();
  });
});
