import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import RedisMock from 'ioredis-mock';
import { RedisService } from '../redis/redis.service';
import { MembersService } from '../organization/members.service';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

/**
 * A session-cache write built from a database read that a role change or a
 * removal overtook. The read is held at a barrier while MembersService
 * commits the change and evicts the cache, then let go: the write that
 * follows must not put the old role, or the old workspace, back for the
 * cache's 15 minutes. RedisService runs over ioredis-mock, which runs the
 * real Lua.
 */
describe('session cache — a write whose read was overtaken by a role change or removal', () => {
  const payload = { sub: 'u2', email: 'u2@shop.com', orgId: 'org', sid: 's2' };

  async function build() {
    const redis = new RedisService({ get: () => 'redis://localhost:6379' } as never);
    const client = new RedisMock();
    (redis as unknown as { client: unknown }).client = client;
    await client.flushall();
    await redis.setAuthSession('s2', 'u2');

    // The member as the database holds it; MembersService writes to it.
    const member = { id: 'm2', organizationId: 'org', userId: 'u2', role: UserRole.ADMIN as UserRole, vendorScope: null, permissions: null, isActive: true };
    const userRow = () => ({
      id: 'u2', email: 'u2@shop.com', emailVerified: true, isSuperAdmin: false, deletedAt: null,
      memberships: member.isActive ? [{ ...member, organization: { id: 'org', name: 'Shop' } }] : [],
    });

    // When set, the next user read takes its snapshot, then waits to return it.
    let hold: { reached: () => void; release: Promise<void> } | null = null;
    const readUser = async () => {
      const snapshot = userRow();
      const held = hold;
      hold = null;
      if (held) {
        held.reached();
        await held.release;
      }
      return snapshot;
    };
    const holdNextRead = () => {
      let reached!: () => void;
      let release!: () => void;
      const atBarrier = new Promise<void>((r) => (reached = r));
      hold = { reached, release: new Promise<void>((r) => (release = r)) };
      return { atBarrier, release };
    };

    const prisma = {
      user: { findFirst: jest.fn(readUser), findUnique: jest.fn(readUser) },
      organizationMember: {
        findFirst: jest.fn(() => Promise.resolve(member.isActive ? { ...member } : null)),
        update: jest.fn(({ data }: { data: Partial<typeof member> }) => Promise.resolve(Object.assign(member, data))),
      },
      conversation: { findMany: jest.fn(() => Promise.resolve([])) },
      inboxTeamMember: { deleteMany: jest.fn(() => Promise.resolve({ count: 0 })) },
      refreshToken: { create: jest.fn(() => Promise.resolve()), updateMany: jest.fn(() => Promise.resolve()) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));

    // Every session-cache write, so the test can wait for the one JwtStrategy does not await.
    const writes: Array<Promise<boolean>> = [];
    const setSession = redis.setSession.bind(redis);
    jest.spyOn(redis, 'setSession').mockImplementation((...args: Parameters<RedisService['setSession']>) => {
      const write = setSession(...args);
      writes.push(write);
      return write;
    });

    const strategy = new JwtStrategy({ get: () => 'secret' } as never, redis, prisma as never);
    const members = new MembersService(prisma as never, redis, { publish: jest.fn() } as never, {} as never);
    const auth = new AuthService(
      prisma as never,
      { sign: () => 'access' } as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
      redis,
    );
    return { redis, strategy, members, auth, holdNextRead, writes };
  }

  it('does not put back a role taken away while a refill was reading', async () => {
    const { redis, strategy, members, holdNextRead, writes } = await build();
    const read = holdNextRead();

    const inFlight = strategy.validate(payload);
    await read.atBarrier;
    await members.updateRole('org', 'm2', UserRole.VIEWER);
    read.release();

    // That one request began before the change and is answered as it was.
    await expect(inFlight).resolves.toMatchObject({ role: UserRole.ADMIN });
    await Promise.all(writes);
    // Every later request sees the change.
    await expect(strategy.validate(payload)).resolves.toMatchObject({ role: UserRole.VIEWER });
    expect(await Promise.all(writes)).toEqual([false, true]);
  });

  it('does not let a removed member back in through a refill that read before the removal', async () => {
    const { strategy, members, holdNextRead, writes } = await build();
    const read = holdNextRead();

    const inFlight = strategy.validate(payload);
    await read.atBarrier;
    await members.remove('org', 'm2');
    read.release();
    await inFlight;
    await Promise.all(writes);

    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await Promise.all(writes)).toEqual([false]);
  });

  it('does not let a token refresh that read before the removal cache the workspace again', async () => {
    const { redis, strategy, members, auth, holdNextRead, writes } = await build();
    await redis.setRefreshToken('old-refresh', { userId: 'u2', orgId: 'org', sid: 's2' });
    const read = holdNextRead();

    const refreshing = auth.rotateRefreshToken('old-refresh');
    await read.atBarrier;
    await members.remove('org', 'm2');
    read.release();
    await refreshing;
    await Promise.all(writes);

    expect(await redis.getSession('u2')).toBeNull();
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await Promise.all(writes)).toEqual([false]);
  });

  it('still caches a refill nothing overtook', async () => {
    const { redis, strategy, writes } = await build();

    await strategy.validate(payload);
    await Promise.all(writes);

    expect(await redis.getSession('u2')).toMatchObject({ orgId: 'org', role: UserRole.ADMIN });
  });
});
