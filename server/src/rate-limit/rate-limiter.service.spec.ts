import type { ConfigService } from '@nestjs/config';
import type { RedisService } from '../redis/redis.service';
import { RateLimiterService } from './rate-limiter.service';
import { LocalFallbackLimiter } from './local-fallback.limiter';
import { Priority, RateLimitScope, RateLimitedError } from './rate-limit.types';

const SHOP: RateLimitScope = { platform: 'shopify', kind: 'bucket', id: 'shop-a.myshopify.com' };
const APP: RateLimitScope = { platform: 'meta', kind: 'app', id: 'app1' };
const PHONE: RateLimitScope = { platform: 'meta', kind: 'phone', id: '919' };

type RunScriptArgs = [name: string, lua: string, nKeys: number, keys: string[], args: unknown[]];

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const table: Record<string, unknown> = {
    'rateLimit.mode': 'enforce',
    'rateLimit.redisTimeoutMs': 250,
    'rateLimit.wait.maxWaitMs': { 1: 10_000, 5: 5_000, 10: 2_000 },
    'rateLimit.wait.parkThresholdMs': { 1: Number.POSITIVE_INFINITY, 5: 5_000, 10: 2_000 },
    'rateLimit.shopify': {
      defaultCostHint: 50, maximumAvailable: 1000, restoreRate: 50,
      watermarks: { 1: 0.05, 5: 0.15, 10: 0.3 }, inflightCap: { 1: 8, 5: 4, 10: 2 },
      leaseTtlMs: 45_000, keyTtlS: 3600, breakerMinMs: 5_000, breakerMaxMs: 120_000,
    },
    'rateLimit.meta': {
      watermarks: { 1: 0.05, 5: 0.15, 10: 0.25 }, inflightCap: { 1: 8, 5: 4, 10: 2 },
      defaultPpc: 0.5, phoneMps: 80, windowSeconds: 3600,
      leaseTtlMs: 45_000, keyTtlS: 3600, breakerMinMs: 30_000, breakerMaxMs: 900_000,
    },
    ...overrides,
  };
  return { get: (k: string) => table[k] } as unknown as ConfigService;
}

function build(overrides: Record<string, unknown> = {}) {
  const runScript = jest.fn<Promise<unknown>, RunScriptArgs>();
  const del = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
  const hgetall = jest.fn<Promise<Record<string, string>>, [string]>().mockResolvedValue({});
  const redis = { runScript, del, hgetall } as unknown as RedisService;
  const service = new RateLimiterService(redis, config(overrides), new LocalFallbackLimiter());
  // Keep the unit tests fast: jitter adds up to 25% / 500 ms.
  jest
    .spyOn(service as unknown as { jitter: (ms: number) => number }, 'jitter')
    .mockImplementation((ms) => ms);
  return { runScript, hgetall, service };
}

const OK = (avail = 470, cost = '50') => [1, 0, 'OK', avail, cost];
const DENY = (waitMs: number, reason: 'BUCKET' | 'INFLIGHT' | 'BREAKER', cost = '50') => [0, waitMs, reason, 0, cost];

describe('RateLimiterService.reserve', () => {
  it('off: touches nothing and hands back a noop lease', async () => {
    const { runScript, service } = build({ 'rateLimit.mode': 'off' });
    const lease = await service.reserve([SHOP], { priority: Priority.BULK });
    expect(lease.noop).toBe(true);
    await service.settle(lease, { actualCost: 32 });
    expect(runScript).not.toHaveBeenCalled();
  });

  it('observe: logs the decision and lets the request through', async () => {
    const { runScript, service } = build({ 'rateLimit.mode': 'observe' });
    runScript.mockResolvedValueOnce(DENY(1400, 'BUCKET'));
    const lease = await service.reserve([SHOP], { priority: Priority.BULK });
    expect(lease.noop).toBe(true);
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it('enforce: passes the policy numbers for the priority into RESERVE', async () => {
    const { runScript, service } = build();
    runScript.mockResolvedValueOnce(OK());
    const lease = await service.reserve([SHOP], { priority: Priority.BULK, cost: 37, channelId: 'ch1' });
    expect(lease).toMatchObject({ noop: false, costs: [50], priority: Priority.BULK, channelId: 'ch1' });
    const [name, , nKeys, keys, args] = runScript.mock.calls[0];
    expect(name).toBe('rlReserve');
    expect(nKeys).toBe(5);
    expect(keys[0]).toBe('rl:shopify:bucket:shop-a.myshopify.com');
    // now, cost, priority, leaseId, defMax, defRate, watermark, cap, leaseTtl, keyTtl, defCost
    expect(args.slice(1, 3)).toEqual([37, Priority.BULK]);
    expect(args.slice(4, 8)).toEqual([1000, 50, 0.3, 2]);
  });

  it('enforce: sleeps through a short wait and tries again', async () => {
    const { runScript, service } = build();
    runScript.mockResolvedValueOnce(DENY(60, 'BUCKET')).mockResolvedValueOnce(OK());
    const started = Date.now();
    const lease = await service.reserve([SHOP], { priority: Priority.BULK });
    expect(lease.noop).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(runScript).toHaveBeenCalledTimes(2);
  });

  it('enforce: a wait above the bulk threshold throws instead of holding the worker', async () => {
    const { runScript, service } = build();
    runScript.mockResolvedValueOnce(DENY(5000, 'BUCKET'));
    await expect(service.reserve([SHOP], { priority: Priority.BULK })).rejects.toMatchObject({
      name: 'RateLimitedError',
      reason: 'BUCKET',
      scope: SHOP,
    });
  });

  it('enforce: a breaker always throws, at any priority', async () => {
    const { runScript, service } = build();
    runScript.mockResolvedValueOnce(DENY(3800, 'BREAKER'));
    const err: unknown = await service.reserve([SHOP], { priority: Priority.INTERACTIVE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAtMs - Date.now()).toBeGreaterThan(3000);
  });

  it('multi-scope: releases the wallets that said yes when a later one says no', async () => {
    const { runScript, service } = build();
    runScript
      .mockResolvedValueOnce(OK(90, '0.5')) // app
      .mockResolvedValueOnce(DENY(5000, 'BUCKET', '1')); // phone
    await expect(service.reserve([APP, PHONE], { priority: Priority.BULK })).rejects.toBeInstanceOf(RateLimitedError);
    const names = runScript.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['rlReserve', 'rlReserve', 'rlRelease']);
    const [, , , releaseKeys, releaseArgs] = runScript.mock.calls[2];
    expect(releaseKeys[0]).toBe('rl:meta:app:app1');
    expect(releaseArgs[0]).toMatch(/^[0-9a-f]{8}\|0\.5\|10$/);
  });

  it('fails open when Redis errors, then skips Redis for the degraded window', async () => {
    const { runScript, service } = build();
    runScript.mockRejectedValue(new Error('ECONNRESET'));
    // A real outage fails every call, so it takes the three consecutive
    // failures to conclude Redis is down; after that nothing else is sent.
    for (let i = 0; i < 4; i++) {
      const lease = await service.reserve([SHOP], { priority: Priority.NORMAL });
      expect(lease.noop).toBe(false); // requests keep flowing throughout
      await service.settle(lease, { actualCost: 10 });
    }
    expect(runScript).toHaveBeenCalledTimes(3);
  });

  it('does NOT switch itself off for one slow call', async () => {
    const { runScript, service } = build();
    // One blip, then Redis is healthy again — the pattern a distant managed
    // Redis produces routinely. Treating that as an outage used to leave the
    // limiter unmetered for ten seconds at a time.
    runScript
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(OK());

    await service.reserve([SHOP], { priority: Priority.NORMAL }); // the blip
    await service.reserve([SHOP], { priority: Priority.NORMAL });
    await service.reserve([SHOP], { priority: Priority.NORMAL });

    expect(runScript).toHaveBeenCalledTimes(3); // still asking Redis
  });

  it('a success resets the failure count, so scattered blips never add up', async () => {
    const { runScript, service } = build();
    // Every other call is slow. Six blips in a row would trip the threshold if
    // successes did not clear it; interleaved, they never should.
    let n = 0;
    runScript.mockImplementation(() =>
      n++ % 2 === 0 ? Promise.reject(new Error('timeout')) : Promise.resolve(OK()),
    );
    for (let i = 0; i < 6; i++) {
      const lease = await service.reserve([SHOP], { priority: Priority.NORMAL });
      await service.settle(lease, { actualCost: 1 });
    }

    // The proof is not the call count (a denial from the in-process fallback
    // legitimately costs a retry) but that Redis is still being consulted.
    const before = runScript.mock.calls.length;
    runScript.mockImplementation(() => Promise.resolve(OK()));
    await service.reserve([SHOP], { priority: Priority.NORMAL });
    expect(runScript.mock.calls.length).toBeGreaterThan(before);
  });

  it('fails open when Redis hangs past the timeout', async () => {
    const { runScript, service } = build({ 'rateLimit.redisTimeoutMs': 40 });
    runScript.mockImplementation(() => new Promise<unknown>(() => undefined));
    const started = Date.now();
    const lease = await service.reserve([SHOP], { priority: Priority.NORMAL });
    expect(lease.noop).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('RateLimiterService.settle / observe / breaker', () => {
  it('settle rebuilds the receipt and forwards the observation', async () => {
    const { runScript, service } = build();
    runScript.mockResolvedValueOnce(OK()).mockResolvedValueOnce(1);
    const lease = await service.reserve([SHOP], { priority: Priority.NORMAL });
    await service.settle(lease, { actualCost: 32, observation: { available: 588, max: 1000, rate: 50, at: 123 } });
    const [name, , , keys, args] = runScript.mock.calls[1];
    expect(name).toBe('rlSettle');
    expect(keys).toEqual([
      'rl:shopify:bucket:shop-a.myshopify.com',
      'rl:lease:shopify:bucket:shop-a.myshopify.com',
      'rl:inflight:shopify:bucket:shop-a.myshopify.com',
    ]);
    expect(args[1]).toBe(`${lease.leaseIds[0]}|50|5`);
    // reservedCost, actualCost, obsAvail, obsMax, obsRate, obsAt, priority
    expect(args.slice(2, 9)).toEqual([50, 32, 588, 1000, 50, 123, Priority.NORMAL]);
  });

  it('observe converts regain minutes into an absolute timestamp', async () => {
    const { runScript, service } = build();
    runScript.mockResolvedValueOnce('0.5');
    const before = Date.now();
    await service.observe(APP, { pct: 62, regainMinutes: 7 });
    const [name, , , keys, args] = runScript.mock.calls[0];
    expect(name).toBe('rlObserve');
    expect(keys).toEqual(['rl:meta:app:app1']);
    expect(args[1]).toBe(62);
    expect(args[3] as number).toBeGreaterThanOrEqual(before + 7 * 60_000);
  });

  it('openBreaker returns the reopen time and notifies listeners', async () => {
    const { runScript, service } = build();
    const until = Date.now() + 4000;
    runScript.mockResolvedValueOnce(String(until));
    const seen: unknown[] = [];
    service.onBreakerOpen((e) => seen.push(e));
    await expect(service.openBreaker(SHOP, { hintMs: 4000, reason: 'HTTP_429', channelId: 'ch1' })).resolves.toBe(until);
    expect(seen).toEqual([{ scope: SHOP, untilMs: until, reason: 'HTTP_429', channelId: 'ch1' }]);
    const [, , , , args] = runScript.mock.calls[0];
    expect(args.slice(1)).toEqual([5000, 120_000, 4000, 'HTTP_429']);
  });

  it('getState reports the breaker only while it is still in the future', async () => {
    const { hgetall, service } = build();
    const breakerAnswer = (breaker: Record<string, string>) => (k: string) =>
      Promise.resolve<Record<string, string>>(k.startsWith('rl:breaker') ? breaker : {});
    hgetall.mockImplementation(breakerAnswer({ until: String(Date.now() - 1) }));
    expect((await service.getState(SHOP)).breaker).toBeNull();
    hgetall.mockImplementation(breakerAnswer({ until: String(Date.now() + 60_000), reason: 'x' }));
    expect((await service.getState(SHOP)).breaker).toMatchObject({ reason: 'x' });
  });
});
