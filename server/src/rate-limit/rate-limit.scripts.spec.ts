import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import {
  BREAKER_OPEN_KEYS,
  BREAKER_OPEN_LUA,
  OBSERVE_KEYS,
  OBSERVE_LUA,
  RELEASE_KEYS,
  RELEASE_LUA,
  RESERVE_KEYS,
  RESERVE_LUA,
  SETTLE_KEYS,
  SETTLE_LUA,
} from './rate-limit.scripts';

// ioredis-mock executes real Lua (fengari), so these tests run the scripts
// that ship, not a TypeScript re-implementation of them.

type ReserveReply = [number, number, string, number, string];

interface ScriptRedis extends Redis {
  reserve(...args: string[]): Promise<ReserveReply>;
  settle(...args: string[]): Promise<number>;
  release(...args: string[]): Promise<number>;
  observe(...args: string[]): Promise<string>;
  breakerOpen(...args: string[]): Promise<string>;
}

const K = { bucket: 'b', leases: 'l', inflight: 'i', breaker: 'k', stats: 's' };
const NOW = 1_700_000_000_000;

interface ReserveArgs {
  now?: number;
  cost?: number;
  prio?: number;
  leaseId?: string;
  defMax?: number;
  defRate?: number;
  watermark?: number;
  cap?: number;
  leaseTtl?: number;
  keyTtl?: number;
  defCost?: number;
}

interface SettleArgs {
  now?: number;
  member: string;
  reserved: number;
  actual?: number;
  obsAvail?: number;
  obsMax?: number;
  obsRate?: number;
  obsAt?: number;
  prio?: number;
}

async function build() {
  const r = new RedisMock() as unknown as ScriptRedis;
  // ioredis-mock shares one store across instances: start every test clean.
  await r.flushall();
  r.defineCommand('reserve', { numberOfKeys: RESERVE_KEYS, lua: RESERVE_LUA });
  r.defineCommand('settle', { numberOfKeys: SETTLE_KEYS, lua: SETTLE_LUA });
  r.defineCommand('release', { numberOfKeys: RELEASE_KEYS, lua: RELEASE_LUA });
  r.defineCommand('observe', { numberOfKeys: OBSERVE_KEYS, lua: OBSERVE_LUA });
  r.defineCommand('breakerOpen', { numberOfKeys: BREAKER_OPEN_KEYS, lua: BREAKER_OPEN_LUA });

  const reserve = (o: ReserveArgs = {}) =>
    r.reserve(
      K.bucket, K.leases, K.inflight, K.breaker, K.stats,
      String(o.now ?? NOW),
      String(o.cost ?? 50),
      String(o.prio ?? 10),
      o.leaseId ?? 'lease1',
      String(o.defMax ?? 1000),
      String(o.defRate ?? 50),
      String(o.watermark ?? 0.3),
      String(o.cap ?? 2),
      String(o.leaseTtl ?? 45_000),
      String(o.keyTtl ?? 3600),
      String(o.defCost ?? 50),
    );

  const settle = (o: SettleArgs) =>
    r.settle(
      K.bucket, K.leases, K.inflight,
      String(o.now ?? NOW), o.member, String(o.reserved), String(o.actual ?? -1),
      String(o.obsAvail ?? -1), String(o.obsMax ?? -1), String(o.obsRate ?? -1),
      String(o.obsAt ?? NOW), String(o.prio ?? 10),
    );

  const bucket = async (): Promise<Record<string, number>> => {
    const h = await r.hgetall(K.bucket);
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v)]));
  };

  return { r, reserve, settle, bucket };
}

describe('RESERVE', () => {
  it('starts a never-seen wallet full and hands out a receipt', async () => {
    const { r, reserve, bucket } = await build();
    const [ok, wait, reason, avail, cost] = await reserve({ cost: 50 });
    expect([ok, wait, reason]).toEqual([1, 0, 'OK']);
    expect(avail).toBe(950);
    expect(cost).toBe('50');
    expect(await bucket()).toMatchObject({ avail: 1000, reserved: 50, max: 1000, rate: 50 });
    expect(await r.zcard(K.leases)).toBe(1);
    expect(await r.hget(K.inflight, 'p10')).toBe('1');
    expect(await r.hget(K.stats, 'allowed')).toBe('1');
  });

  it('refills for the time that passed since the last write', async () => {
    const { r, reserve, bucket } = await build();
    await r.hset(K.bucket, 'avail', 420, 'max', 1000, 'rate', 50, 'at', NOW - 4000, 'reserved', 100);
    const [ok, , , avail] = await reserve({ cost: 50 });
    // 420 + 4 s × 50 = 620; minus 100 already promised, minus this 50.
    expect(ok).toBe(1);
    expect(avail).toBe(470);
    expect((await bucket()).avail).toBe(620);
  });

  it('never refills past the maximum', async () => {
    const { r, reserve, bucket } = await build();
    await r.hset(K.bucket, 'avail', 990, 'max', 1000, 'rate', 50, 'at', NOW - 60_000);
    await reserve({ cost: 1 });
    expect((await bucket()).avail).toBe(1000);
  });

  it('applies the watermark per priority: bulk stops where interactive still passes', async () => {
    const { r, reserve } = await build();
    await r.hset(K.bucket, 'avail', 380, 'max', 1000, 'rate', 50, 'at', NOW, 'reserved', 100);
    // effective 280; bulk floor 300 → short by 70 → 1400 ms at 50/s
    const bulk = await reserve({ cost: 50, prio: 10, watermark: 0.3 });
    expect(bulk.slice(0, 3)).toEqual([0, 1400, 'BUCKET']);
    expect(await r.hget(K.stats, 'waited')).toBe('1');
    const interactive = await reserve({ cost: 50, prio: 1, watermark: 0.05, leaseId: 'i1' });
    expect(interactive[0]).toBe(1);
  });

  it('caps in-flight requests per priority per wallet', async () => {
    const { r, reserve } = await build();
    expect((await reserve({ leaseId: 'a' }))[0]).toBe(1);
    expect((await reserve({ leaseId: 'b' }))[0]).toBe(1);
    const third = await reserve({ leaseId: 'c' });
    expect(third.slice(0, 3)).toEqual([0, 250, 'INFLIGHT']);
    // Counted, so the endpoint can say why a caller was held back. Without it
    // a burst reads as "allowed=2" with no explanation for the rest.
    expect(await r.hget(K.stats, 'inflight')).toBe('1');
    expect(await r.hget(K.stats, 'waited')).toBeNull();
    // A different priority class has its own counter.
    expect((await reserve({ leaseId: 'd', prio: 5, cap: 4 }))[0]).toBe(1);
  });

  it('purges receipts whose holder crashed and gives the money back', async () => {
    const { r, reserve, bucket } = await build();
    await r.hset(K.bucket, 'avail', 500, 'max', 1000, 'rate', 50, 'at', NOW, 'reserved', 340);
    await r.hset(K.inflight, 'p5', 1, 'p10', 1);
    await r.zadd(K.leases, NOW - 1, 'dead|40|5'); // expired
    await r.zadd(K.leases, NOW + 40_000, 'live|300|10'); // still open
    const [ok, , , avail] = await reserve({ cost: 50, prio: 5, cap: 4, watermark: 0.15 });
    expect(ok).toBe(1);
    // reserved 340 → 300 after purge, + 50 now = 350; effective 500-300-50 = 150
    expect(avail).toBe(150);
    expect((await bucket()).reserved).toBe(350);
    expect(await r.hget(K.inflight, 'p5')).toBe('1'); // -1 purge, +1 this one
    expect(await r.zcard(K.leases)).toBe(2);
  });

  it('refuses everything while a breaker is open, without touching the wallet', async () => {
    const { r, reserve, bucket } = await build();
    await r.hset(K.breaker, 'until', NOW + 3800);
    const res = await reserve({ prio: 1, watermark: 0.05 });
    expect(res.slice(0, 3)).toEqual([0, 3800, 'BREAKER']);
    expect(await bucket()).toEqual({});
    expect(await r.hget(K.stats, 'parked')).toBe('1');
  });

  it('refuses while Meta says access is regained later', async () => {
    const { r, reserve } = await build();
    await r.hset(K.bucket, 'avail', 90, 'max', 100, 'rate', 0.03, 'at', NOW, 'regainAt', NOW + 60_000);
    const res = await reserve({ cost: -1, defCost: 0.5 });
    expect(res.slice(0, 3)).toEqual([0, 60_000, 'BREAKER']);
  });

  it('uses the learned percent-per-call when the caller passes cost -1', async () => {
    const { r, reserve } = await build();
    await r.hset(K.bucket, 'avail', 60, 'max', 100, 'rate', 0.03, 'at', NOW, 'ppc', 0.8);
    const [ok, , , , cost] = await reserve({ cost: -1, defCost: 0.5, watermark: 0.25 });
    expect(ok).toBe(1);
    expect(cost).toBe('0.8');
  });
});

describe('SETTLE', () => {
  it('closes the receipt and overwrites the estimate with the platform balance', async () => {
    const { r, reserve, settle, bucket } = await build();
    await reserve({ cost: 50, leaseId: 'x' });
    await settle({ member: 'x|50|10', reserved: 50, actual: 32, obsAvail: 588, obsMax: 1000, obsRate: 50, obsAt: NOW + 400 });
    expect(await bucket()).toMatchObject({ avail: 588, reserved: 0, obsAt: NOW + 400 });
    expect(await r.zcard(K.leases)).toBe(0);
    expect(await r.hget(K.inflight, 'p10')).toBe('0');
  });

  it('deducts the real cost when the platform reported no balance', async () => {
    const { reserve, settle, bucket } = await build();
    await reserve({ cost: 50, leaseId: 'x' });
    await settle({ member: 'x|50|10', reserved: 50, actual: 32 });
    expect(await bucket()).toMatchObject({ avail: 968, reserved: 0 });
  });

  it('deducts the reserved amount when the real cost is unknown', async () => {
    const { reserve, settle, bucket } = await build();
    await reserve({ cost: 50, leaseId: 'x' });
    await settle({ member: 'x|50|10', reserved: 50 });
    expect((await bucket()).avail).toBe(950);
  });

  it('gives the money back when nothing was spent', async () => {
    const { reserve, settle, bucket } = await build();
    await reserve({ cost: 50, leaseId: 'x' });
    await settle({ member: 'x|50|10', reserved: 50, actual: 0 });
    expect(await bucket()).toMatchObject({ avail: 1000, reserved: 0 });
  });

  it('ignores an observation older than the last one stored', async () => {
    const { r, reserve, settle, bucket } = await build();
    await reserve({ cost: 50, leaseId: 'x' });
    await r.hset(K.bucket, 'obsAt', NOW + 1000, 'avail', 700);
    await settle({ member: 'x|50|10', reserved: 50, actual: 32, obsAvail: 100, obsMax: 1000, obsRate: 50, obsAt: NOW + 500 });
    // Stale reply: falls through to the real-cost deduction instead.
    expect((await bucket()).avail).toBe(668);
  });

  it('does not double-refund a receipt the purge already removed', async () => {
    const { reserve, settle, bucket } = await build();
    await reserve({ cost: 50, leaseId: 'x' });
    await settle({ member: 'x|50|10', reserved: 50, actual: 0 });
    await settle({ member: 'x|50|10', reserved: 50, actual: 0 });
    expect((await bucket()).reserved).toBe(0);
  });
});

describe('RELEASE', () => {
  it('tears up a receipt with no correction to the balance', async () => {
    const { r, reserve, bucket } = await build();
    await reserve({ cost: 50, leaseId: 'x' });
    await r.release(K.bucket, K.leases, K.inflight, 'x|50|10', '50', '10');
    expect(await bucket()).toMatchObject({ avail: 1000, reserved: 0 });
    expect(await r.hget(K.inflight, 'p10')).toBe('0');
    expect(await r.zcard(K.leases)).toBe(0);
  });
});

describe('OBSERVE', () => {
  it('turns a Meta percentage into a wallet and learns the cost per call', async () => {
    const { r, bucket } = await build();
    await r.observe(K.bucket, String(NOW), '40', '3600', '-1', '1', '3600', '0.5');
    expect(await bucket()).toMatchObject({ avail: 60, max: 100, lastPct: 40, ppc: 0.5 });
    // 10 calls later it reads 46%: 0.6/call, blended 80/20 → 0.52
    const ppc = await r.observe(K.bucket, String(NOW + 5000), '46', '3600', '-1', '10', '3600', '0.5');
    expect(Number(ppc)).toBeCloseTo(0.52, 5);
    expect((await bucket()).avail).toBe(54);
  });

  it('records a regain-access lockout', async () => {
    const { r, bucket } = await build();
    await r.observe(K.bucket, String(NOW), '100', '3600', String(NOW + 420_000), '1', '3600', '0.5');
    expect((await bucket()).regainAt).toBe(NOW + 420_000);
  });

  it('skips learning when the window rolled over (percentage went down)', async () => {
    const { r, bucket } = await build();
    await r.observe(K.bucket, String(NOW), '90', '3600', '-1', '1', '3600', '0.5');
    await r.observe(K.bucket, String(NOW + 1), '5', '3600', '-1', '3', '3600', '0.5');
    expect((await bucket()).ppc).toBe(0.5);
  });
});

describe('BREAKER_OPEN', () => {
  const open = (r: ScriptRedis, now: number, hint = -1) =>
    r.breakerOpen(K.breaker, K.stats, String(now), '5000', '120000', String(hint), 'HTTP_429');

  it('obeys the hint when the API gave one', async () => {
    const { r } = await build();
    expect(Number(await open(r, NOW, 4000))).toBe(NOW + 4000);
    expect(await r.hget(K.breaker, 'reason')).toBe('HTTP_429');
    expect(await r.hget(K.stats, 'breakerOpens')).toBe('1');
  });

  it('doubles from the minimum on each repeat, up to the maximum', async () => {
    const { r } = await build();
    expect(Number(await open(r, NOW)) - NOW).toBe(5000);
    expect(Number(await open(r, NOW)) - NOW).toBe(10_000);
    expect(Number(await open(r, NOW)) - NOW).toBe(20_000);
    for (let i = 0; i < 10; i++) await open(r, NOW);
    expect(Number(await open(r, NOW)) - NOW).toBe(120_000);
  });
});
