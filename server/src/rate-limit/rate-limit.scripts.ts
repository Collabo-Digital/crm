/**
 * Lua scripts that run INSIDE Redis.
 *
 * Each script is one atomic step: Redis executes it start to finish with no
 * other command interleaved, so two workers can never both read "60 left" and
 * both take 50. That is the whole reason the wallet maths lives here and not
 * in TypeScript.
 *
 * Key layout for one scope, S = rl:{platform}:{kind}:{id} (see scopeKey):
 *   S               HASH  avail max rate at reserved obsAt regainAt lastPct ppc
 *   rl:lease:...    ZSET  member "leaseId|cost|priority", score = expiresAt ms
 *   rl:inflight:... HASH  p1 p5 p10
 *   rl:breaker:...  HASH  until reason opens openedAt
 *   rl:stats:{platform}:{id}:{yyyymmdd}
 *                   HASH  allowed waited inflight parked throttled breakerOpens
 *
 * Counter meanings, since they are what the /rate-limit endpoint shows:
 *   allowed      reservations granted
 *   waited       refused because the wallet is at this priority's floor
 *   inflight     refused because this tenant already has enough in flight
 *   parked       refused because a breaker (or Meta regain-time) is open
 *   throttled    the remote API actually refused us — should stay 0
 *   breakerOpens times a cooldown was opened
 *
 * Numbers only, no cjson: ioredis-mock executes these under fengari for the
 * unit tests, and it does not ship the JSON library.
 *
 * `redis.call('HGET', ...)` returns false for a missing field; `x or default`
 * therefore covers both nil and false.
 */

export const RESERVE_KEYS = 5;
export const RESERVE_LUA = `
-- KEYS: 1 bucket, 2 leases, 3 inflight, 4 breaker, 5 stats
-- ARGV: 1 now, 2 cost (-1 = use learned ppc), 3 priority, 4 leaseId,
--       5 defMax, 6 defRate, 7 watermark, 8 inflightCap, 9 leaseTtlMs,
--       10 keyTtlS, 11 defCost
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local prio = ARGV[3]

local until_ = tonumber(redis.call('HGET', KEYS[4], 'until') or '0')
if until_ > now then
  redis.call('HINCRBY', KEYS[5], 'parked', 1)
  redis.call('EXPIRE', KEYS[5], 691200)
  return {0, until_ - now, 'BREAKER', 0, '0'}
end

local regainAt = tonumber(redis.call('HGET', KEYS[1], 'regainAt') or '0')
if regainAt > now then
  redis.call('HINCRBY', KEYS[5], 'parked', 1)
  redis.call('EXPIRE', KEYS[5], 691200)
  return {0, regainAt - now, 'BREAKER', 0, '0'}
end

if cost < 0 then
  cost = tonumber(redis.call('HGET', KEYS[1], 'ppc') or ARGV[11])
end

local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, m in ipairs(expired) do
  local c, p = string.match(m, '^[^|]+|([%d%.]+)|(%d+)$')
  if c then
    reserved = reserved - tonumber(c)
    redis.call('HINCRBY', KEYS[3], 'p' .. p, -1)
  end
  redis.call('ZREM', KEYS[2], m)
end
if reserved < 0 then reserved = 0 end

local max = tonumber(redis.call('HGET', KEYS[1], 'max') or ARGV[5])
local rate = tonumber(redis.call('HGET', KEYS[1], 'rate') or ARGV[6])
local avail = tonumber(redis.call('HGET', KEYS[1], 'avail') or ARGV[5])
local at = tonumber(redis.call('HGET', KEYS[1], 'at') or ARGV[1])

if now > at then
  avail = math.min(max, avail + (now - at) / 1000 * rate)
  at = now
end

local effective = avail - reserved
local floor = max * tonumber(ARGV[7])
if effective - cost < floor then
  redis.call('HSET', KEYS[1], 'avail', avail, 'at', at, 'reserved', reserved, 'max', max, 'rate', rate)
  redis.call('EXPIRE', KEYS[1], ARGV[10])
  redis.call('HINCRBY', KEYS[5], 'waited', 1)
  redis.call('EXPIRE', KEYS[5], 691200)
  local waitMs = 50
  if rate > 0 then
    waitMs = math.ceil((floor + cost - effective) / rate * 1000)
    if waitMs < 50 then waitMs = 50 end
  end
  return {0, waitMs, 'BUCKET', 0, tostring(cost)}
end

local n = tonumber(redis.call('HGET', KEYS[3], 'p' .. prio) or '0')
if n < 0 then n = 0 end
if n >= tonumber(ARGV[8]) then
  redis.call('HSET', KEYS[1], 'avail', avail, 'at', at, 'reserved', reserved, 'max', max, 'rate', rate)
  redis.call('EXPIRE', KEYS[1], ARGV[10])
  -- Counted apart from the wallet denial above: this caller was held back
  -- because its own tenant already has enough requests in flight, not because
  -- the shop is short of budget. Without this the stats read "allowed=5" and
  -- nothing else, saying nothing about why the other twenty were held.
  -- (No backticks in here: the whole script is a TS template literal.)
  redis.call('HINCRBY', KEYS[5], 'inflight', 1)
  redis.call('EXPIRE', KEYS[5], 691200)
  return {0, 250, 'INFLIGHT', 0, tostring(cost)}
end

reserved = reserved + cost
redis.call('HSET', KEYS[1], 'avail', avail, 'at', at, 'reserved', reserved, 'max', max, 'rate', rate)
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[9]), ARGV[4] .. '|' .. tostring(cost) .. '|' .. prio)
redis.call('HINCRBY', KEYS[3], 'p' .. prio, 1)
redis.call('HINCRBY', KEYS[5], 'allowed', 1)
redis.call('EXPIRE', KEYS[1], ARGV[10])
redis.call('EXPIRE', KEYS[2], ARGV[10])
redis.call('EXPIRE', KEYS[3], ARGV[10])
redis.call('EXPIRE', KEYS[5], 691200)
return {1, 0, 'OK', math.floor(effective - cost), tostring(cost)}
`;

export const SETTLE_KEYS = 3;
export const SETTLE_LUA = `
-- KEYS: 1 bucket, 2 leases, 3 inflight
-- ARGV: 1 now, 2 member, 3 reservedCost, 4 actualCost (-1 unknown),
--       5 obsAvail (-1 none), 6 obsMax, 7 obsRate, 8 obsAt, 9 priority
if redis.call('ZREM', KEYS[2], ARGV[2]) == 1 then
  local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') - tonumber(ARGV[3])
  if reserved < 0 then reserved = 0 end
  redis.call('HSET', KEYS[1], 'reserved', reserved)
  local n = redis.call('HINCRBY', KEYS[3], 'p' .. ARGV[9], -1)
  if n < 0 then redis.call('HSET', KEYS[3], 'p' .. ARGV[9], 0) end
end

-- RESERVE never lowers avail; it only raises reserved. So once the receipt is
-- closed the money really spent has to come out of avail here, unless the
-- platform reported its own balance, which wins outright.
local obsAvail = tonumber(ARGV[5])
local lastObs = tonumber(redis.call('HGET', KEYS[1], 'obsAt') or '0')
if obsAvail >= 0 and tonumber(ARGV[8]) >= lastObs then
  redis.call('HSET', KEYS[1],
    'avail', obsAvail, 'max', ARGV[6], 'rate', ARGV[7],
    'at', ARGV[8], 'obsAt', ARGV[8])
else
  local spent = tonumber(ARGV[4])
  if spent < 0 then spent = tonumber(ARGV[3]) end
  if spent > 0 then
    local avail = tonumber(redis.call('HGET', KEYS[1], 'avail') or '0')
    redis.call('HSET', KEYS[1], 'avail', avail - spent)
  end
end
return 1
`;

export const RELEASE_KEYS = 3;
export const RELEASE_LUA = `
-- KEYS: 1 bucket, 2 leases, 3 inflight
-- ARGV: 1 member, 2 reservedCost, 3 priority
if redis.call('ZREM', KEYS[2], ARGV[1]) == 1 then
  local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') - tonumber(ARGV[2])
  if reserved < 0 then reserved = 0 end
  redis.call('HSET', KEYS[1], 'reserved', reserved)
  local n = redis.call('HINCRBY', KEYS[3], 'p' .. ARGV[3], -1)
  if n < 0 then redis.call('HSET', KEYS[3], 'p' .. ARGV[3], 0) end
end
return 1
`;

export const OBSERVE_KEYS = 1;
export const OBSERVE_LUA = `
-- KEYS: 1 bucket
-- ARGV: 1 now, 2 pct, 3 windowS, 4 regainAtMs (-1 none), 5 callsSinceLast,
--       6 keyTtlS, 7 defPpc
local now = tonumber(ARGV[1])
local pct = tonumber(ARGV[2])
local lastPct = tonumber(redis.call('HGET', KEYS[1], 'lastPct') or '-1')
local calls = tonumber(ARGV[5])
local ppc = tonumber(redis.call('HGET', KEYS[1], 'ppc') or ARGV[7])

if lastPct >= 0 and calls > 0 and pct >= lastPct then
  local sample = (pct - lastPct) / calls
  ppc = ppc * 0.8 + sample * 0.2
  if ppc < 0.01 then ppc = 0.01 end
end

redis.call('HSET', KEYS[1],
  'avail', 100 - pct, 'max', 100, 'rate', 100 / tonumber(ARGV[3]),
  'at', now, 'obsAt', now, 'lastPct', pct, 'ppc', ppc)
if tonumber(ARGV[4]) > 0 then
  redis.call('HSET', KEYS[1], 'regainAt', ARGV[4])
end
redis.call('EXPIRE', KEYS[1], ARGV[6])
return tostring(ppc)
`;

export const BREAKER_OPEN_KEYS = 2;
export const BREAKER_OPEN_LUA = `
-- KEYS: 1 breaker, 2 stats
-- ARGV: 1 now, 2 minMs, 3 maxMs, 4 hintMs (-1 none), 5 reason
local now = tonumber(ARGV[1])
local opens = redis.call('HINCRBY', KEYS[1], 'opens', 1)
local dur
if tonumber(ARGV[4]) > 0 then
  dur = tonumber(ARGV[4])
else
  dur = math.min(tonumber(ARGV[3]), tonumber(ARGV[2]) * (2 ^ (opens - 1)))
end
local until_ = now + dur
redis.call('HSET', KEYS[1], 'until', until_, 'reason', ARGV[5], 'openedAt', now)
redis.call('PEXPIRE', KEYS[1], math.floor(dur + 600000))
redis.call('HINCRBY', KEYS[2], 'breakerOpens', 1)
redis.call('EXPIRE', KEYS[2], 691200)
return tostring(until_)
`;

export const THROTTLED_KEYS = 1;
export const THROTTLED_LUA = `
-- KEYS: 1 stats
redis.call('HINCRBY', KEYS[1], 'throttled', 1)
redis.call('EXPIRE', KEYS[1], 691200)
return 1
`;
