import { HttpException, HttpStatus } from '@nestjs/common';
import { InviteStatus, OrganizationType, UserRole } from '@prisma/client';
import RedisMock from 'ioredis-mock';
import { RedisService } from '../redis/redis.service';
import { INVITE_SEND_LIMIT, REDIS_KEYS, REDIS_PREFIX } from '../redis/redis.constants';
import { InvitesService } from './invites.service';

/**
 * Invitation emails go out through the SMTP account every workspace's
 * sign-up and reset mail shares, and any signed-in account can make a
 * workspace to send them from. They are limited per recipient, like other
 * account emails, and per sender, and a refused one writes nothing.
 */
describe('InvitesService — invitation email limits', () => {
  async function build() {
    const redis = new RedisService({ get: () => 'redis://localhost:6379' } as never);
    const client = new RedisMock();
    (redis as unknown as { client: unknown }).client = client;
    await client.flushall();

    const prisma = {
      organization: { findUnique: jest.fn(() => Promise.resolve({ id: 'org', name: 'Shop', type: OrganizationType.ORGANIZATION })) },
      teamInvite: {
        findFirst: jest.fn((_: { where: { id?: string } }) => Promise.resolve(null as unknown)),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'inv', status: InviteStatus.PENDING, vendorScope: null, createdAt: new Date(), ...data }),
        ),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'inv', email: 'priya@mail.test', name: null, role: UserRole.AGENT, vendorScope: null, permissions: null, createdAt: new Date(), ...data }),
        ),
      },
    };
    const email = { sendTeamInvite: jest.fn(() => Promise.resolve()) };
    const users = { findIdByEmail: jest.fn(() => Promise.resolve(null)) };
    const service = new InvitesService(prisma as never, email as never, users as never, redis);
    return { service, prisma, email, client };
  }

  const status = (err: unknown) => (err instanceof HttpException ? err.getStatus() : err);
  const invite = (to: string) => ({ email: to, role: UserRole.AGENT });

  it('refuses to email the same address again moments later, from any workspace, and writes nothing', async () => {
    const { service, prisma, email } = await build();
    await service.send('org', 'u-owner', invite('priya@mail.test'));

    const fromAnotherWorkspace = await service.send('org-2', 'u-stranger', invite('priya@mail.test')).catch(status);

    expect(fromAnotherWorkspace).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(email.sendTeamInvite).toHaveBeenCalledTimes(1);
    expect(prisma.teamInvite.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a resend moments after the invitation went out, without re-issuing its link', async () => {
    const { service, prisma, email } = await build();
    await service.send('org', 'u-owner', invite('priya@mail.test'));
    prisma.teamInvite.findFirst.mockResolvedValue({ id: 'inv', email: 'priya@mail.test', status: InviteStatus.PENDING, organization: { name: 'Shop' } });

    await expect(service.resend('org', 'inv', 'u-owner').catch(status)).resolves.toBe(HttpStatus.TOO_MANY_REQUESTS);

    expect(prisma.teamInvite.update).not.toHaveBeenCalled();
    expect(email.sendTeamInvite).toHaveBeenCalledTimes(1);
  });

  it('caps the invitation emails one member sends in a day', async () => {
    const { service, email, client } = await build();
    // As if the member had already sent the day's allowance.
    await client.set(`${REDIS_PREFIX}${REDIS_KEYS.INVITE_SENDER_COUNT}u-owner`, String(INVITE_SEND_LIMIT.MAX_PER_SENDER_PER_DAY), 'EX', 86400);

    const refused = await service.send('org', 'u-owner', invite('someone-new@mail.test')).catch(status);

    expect(refused).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(email.sendTeamInvite).not.toHaveBeenCalled();
    // Another member of the workspace is not held to it.
    await expect(service.send('org', 'u-admin', invite('someone-new@mail.test'))).resolves.toMatchObject({ email: 'someone-new@mail.test' });
  });

  it('lets a member invite a whole team at once', async () => {
    const { service, email } = await build();

    for (let i = 0; i < 30; i++) await service.send('org', 'u-owner', invite(`teammate${i}@mail.test`));

    expect(email.sendTeamInvite).toHaveBeenCalledTimes(30);
  });
});
