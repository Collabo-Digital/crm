import type { ConfigService } from '@nestjs/config';
import type { RedisService } from '../redis/redis.service';
import type { RateLimiterService } from '../rate-limit/rate-limiter.service';
import type { CostHintStore } from '../rate-limit/cost-hint.store';
import { ShopifyGraphqlClient } from './shopify-graphql.client';
import { Lease, Observation, Priority, RateLimitScope } from '../rate-limit/rate-limit.types';

const SHOP = 'shop-a.myshopify.com';
const QUERY = 'query { shop { name } }';

type SettleResult = { actualCost?: number; observation?: Observation };
type ReserveOpts = { priority: Priority; cost?: number; channelId?: string };

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const costBlock = (actual: number, avail: number, requested = 50) => ({
  cost: {
    requestedQueryCost: requested,
    actualQueryCost: actual,
    throttleStatus: { maximumAvailable: 1000, currentlyAvailable: avail, restoreRate: 50 },
  },
});

function build(mode: 'enforce' | 'observe' | 'off' = 'enforce') {
  const lease: Lease = { leaseIds: ['k3f9a2'], costs: [37], scopes: [], priority: Priority.NORMAL, noop: false };
  const limiter = {
    mode: jest.fn(() => mode),
    reserve: jest.fn<Promise<Lease>, [RateLimitScope[], ReserveOpts]>().mockResolvedValue(lease),
    settle: jest.fn<Promise<void>, [Lease, SettleResult]>().mockResolvedValue(undefined),
    openBreaker: jest
      .fn<Promise<number>, [RateLimitScope, { hintMs?: number; reason: string; channelId?: string }]>()
      .mockResolvedValue(Date.now() + 4000),
    recordThrottled: jest.fn<Promise<void>, [RateLimitScope, Record<string, unknown>]>().mockResolvedValue(undefined),
  };
  const costHints = {
    get: jest.fn<Promise<number | undefined>, [string, unknown]>().mockResolvedValue(37),
    learn: jest.fn<Promise<void>, [string, unknown, number]>().mockResolvedValue(undefined),
  };
  const redis = {
    get: jest.fn<Promise<unknown>, [string]>().mockResolvedValue(null),
    set: jest.fn<Promise<void>, [string, unknown, number]>().mockResolvedValue(undefined),
  };
  const config = { get: (k: string) => (k === 'shopify.apiVersion' ? '2026-01' : undefined) };
  const client = new ShopifyGraphqlClient(
    config as unknown as ConfigService,
    redis as unknown as RedisService,
    limiter as unknown as RateLimiterService,
    costHints as unknown as CostHintStore,
  );
  jest
    .spyOn(client as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
    .mockResolvedValue(undefined);
  const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>();
  global.fetch = fetchMock as unknown as typeof fetch;
  return { client, limiter, costHints, redis, fetchMock, lease };
}

describe('ShopifyGraphqlClient + rate limiter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reserves the learned cost before fetch and settles with the real cost after', async () => {
    const { client, limiter, costHints, fetchMock, redis } = build();
    fetchMock.mockResolvedValueOnce(json({ data: { shop: { name: 'A' } }, extensions: costBlock(32, 588) }));

    const data = await client.request({ shopDomain: SHOP, accessToken: 't', channelId: 'ch1' }, QUERY, { first: 50 });

    expect(data).toEqual({ shop: { name: 'A' } });
    expect(costHints.get).toHaveBeenCalledWith(QUERY, { first: 50 });
    expect(limiter.reserve).toHaveBeenCalledWith(
      [{ platform: 'shopify', kind: 'bucket', id: SHOP }],
      { priority: Priority.NORMAL, cost: 37, channelId: 'ch1' },
    );
    expect(limiter.reserve.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(limiter.settle).toHaveBeenCalledTimes(1);
    expect(limiter.settle.mock.calls[0][1]).toMatchObject({
      actualCost: 32,
      observation: { available: 588, max: 1000, rate: 50 },
    });
    expect(costHints.learn).toHaveBeenCalledWith(QUERY, { first: 50 }, 50);
    // Enforcing: the old shared-reading pacing is bypassed.
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('the 4-argument call still works and defaults to NORMAL priority', async () => {
    const { client, limiter, fetchMock } = build();
    fetchMock.mockResolvedValueOnce(json({ data: { ok: true } }));
    await client.request({ shopDomain: SHOP, accessToken: 't' }, QUERY, undefined, '2026-04');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/api/2026-04/graphql.json');
    expect(limiter.reserve.mock.calls[0][1]).toMatchObject({ priority: Priority.NORMAL });
  });

  it('takes priority from the options bag, then from the auth context', async () => {
    const { client, limiter, fetchMock } = build();
    // A Response body can be read once: build a fresh one per call.
    fetchMock.mockImplementation(() => Promise.resolve(json({ data: { ok: true } })));
    await client.request({ shopDomain: SHOP, accessToken: 't', priority: Priority.BULK }, QUERY);
    await client.request({ shopDomain: SHOP, accessToken: 't', priority: Priority.BULK }, QUERY, undefined, undefined, {
      priority: Priority.INTERACTIVE,
      costHint: 200,
    });
    expect(limiter.reserve.mock.calls[0][1]).toMatchObject({ priority: Priority.BULK, cost: 37 });
    expect(limiter.reserve.mock.calls[1][1]).toMatchObject({ priority: Priority.INTERACTIVE, cost: 200 });
  });

  it('HTTP 429: settles nothing spent, records the throttle, opens the breaker with the hint, retries', async () => {
    const { client, limiter, fetchMock } = build();
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '4' } }))
      .mockResolvedValueOnce(json({ data: { ok: true }, extensions: costBlock(10, 900) }));

    await expect(client.request({ shopDomain: SHOP, accessToken: 't', channelId: 'ch1' }, QUERY)).resolves.toEqual({ ok: true });

    expect(limiter.settle.mock.calls[0][1]).toEqual({ actualCost: 0 });
    expect(limiter.recordThrottled).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHOP }),
      expect.objectContaining({ kind: 'HTTP_429', waitMs: 4000 }),
    );
    expect(limiter.openBreaker).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHOP }),
      { hintMs: 4000, reason: 'HTTP_429', channelId: 'ch1' },
    );
    expect(limiter.reserve).toHaveBeenCalledTimes(2);
  });

  it('body-level THROTTLED: resyncs the wallet from the reply; opens the breaker only on the second in a row', async () => {
    const { client, limiter, fetchMock } = build();
    const throttled = () =>
      json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: costBlock(0, 12, 300) });
    fetchMock
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(json({ data: { ok: true }, extensions: costBlock(300, 400, 300) }));

    await client.request({ shopDomain: SHOP, accessToken: 't' }, QUERY);

    expect(limiter.settle.mock.calls[0][1]).toMatchObject({ actualCost: 0, observation: { available: 12 } });
    expect(limiter.recordThrottled).toHaveBeenCalledTimes(2);
    expect(limiter.openBreaker).toHaveBeenCalledTimes(1);
    expect(limiter.openBreaker.mock.calls[0][1]).toMatchObject({ reason: 'THROTTLED' });
  });

  it('a timed-out fetch settles the reservation so the wallet never leaks', async () => {
    const { client, limiter, fetchMock } = build();
    fetchMock.mockImplementation(() => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      return Promise.reject(e);
    });
    await expect(client.request({ shopDomain: SHOP, accessToken: 't' }, QUERY)).rejects.toMatchObject({ code: 'TIMEOUT' });
    // 2 transport retries + the final attempt = 3 reservations, 3 settles of 0.
    expect(limiter.reserve).toHaveBeenCalledTimes(3);
    expect(limiter.settle).toHaveBeenCalledTimes(3);
    expect(limiter.settle.mock.calls.every((c) => c[1].actualCost === 0)).toBe(true);
  });

  it('GraphQL errors settle with the actual cost and throw as before', async () => {
    const { client, limiter, fetchMock } = build();
    fetchMock.mockResolvedValueOnce(
      json({ errors: [{ message: 'bad', extensions: { code: 'MAX_COST_EXCEEDED' } }], extensions: costBlock(0, 900, 2000) }),
    );
    await expect(client.request({ shopDomain: SHOP, accessToken: 't' }, QUERY)).rejects.toMatchObject({ code: 'MAX_COST_EXCEEDED' });
    expect(limiter.settle).toHaveBeenCalledTimes(1);
  });

  it('observe mode keeps the old shared-reading pacing in place', async () => {
    const { client, redis, fetchMock, limiter } = build('observe');
    fetchMock.mockResolvedValueOnce(json({ data: { ok: true }, extensions: costBlock(5, 990) }));
    await client.request({ shopDomain: SHOP, accessToken: 't' }, QUERY);
    expect(redis.get).toHaveBeenCalledWith(`shopify:bucket:${SHOP}`);
    expect(redis.set).toHaveBeenCalled();
    expect(limiter.reserve).toHaveBeenCalledTimes(1);
  });

  it('off mode skips the cost-hint lookup entirely', async () => {
    const { client, costHints, fetchMock } = build('off');
    fetchMock.mockResolvedValueOnce(json({ data: { ok: true } }));
    await client.request({ shopDomain: SHOP, accessToken: 't' }, QUERY);
    expect(costHints.get).not.toHaveBeenCalled();
    expect(costHints.learn).not.toHaveBeenCalled();
  });
});
