/**
 * ioredis-mock ships no type declarations. It mirrors the ioredis `Redis`
 * class (including `defineCommand`, which runs real Lua under fengari), so
 * that is what the tests type it as.
 */
declare module 'ioredis-mock' {
  import type { Redis, RedisOptions } from 'ioredis';

  const RedisMock: new (options?: RedisOptions) => Redis;
  export default RedisMock;
}
