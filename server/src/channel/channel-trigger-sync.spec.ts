import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ChannelPlatform, SyncStatus } from '@prisma/client';
import { ChannelController } from './channel.controller';

/**
 * POST /channels/:id/sync claims the channel (syncStatus → IN_PROGRESS) before
 * it queues the job. These pin the three things that claim exists for: the
 * status is true from the first response, one channel never gets two sync
 * jobs, and a queue outage cannot leave the row stuck on "Syncing".
 */
describe('ChannelController.triggerSync', () => {
  const user = { sub: 'u1', orgId: 'org-1' } as never;
  const dto = { entityTypes: ['products', 'orders'] } as never;

  function build(opts: {
    platform?: ChannelPlatform;
    syncStatus?: SyncStatus;
    claimCount?: number;
    queuedJobs?: Array<{ data: Record<string, unknown> }>;
    latestLogStartedAt?: Date | null;
    addRejects?: boolean;
  }) {
    const prisma = {
      channel: {
        findFirst: jest.fn().mockResolvedValue({
          platform: opts.platform ?? ChannelPlatform.SHOPIFY,
          syncStatus: opts.syncStatus ?? SyncStatus.COMPLETED,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      },
      syncLog: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            opts.latestLogStartedAt ? { startedAt: opts.latestLogStartedAt } : null,
          ),
      },
    };
    const queue = {
      add: opts.addRejects
        ? jest.fn().mockRejectedValue(new Error('redis down'))
        : jest.fn().mockResolvedValue({ id: 'job-1' }),
      getJobs: jest.fn().mockResolvedValue(opts.queuedJobs ?? []),
    };
    const controller = new ChannelController(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      queue as never,
    );
    // Silence the expected warn/error lines.
    jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(controller['logger'], 'error').mockImplementation(() => undefined);
    return { controller, prisma, queue };
  }

  it('claims the channel, then queues exactly one job', async () => {
    const { controller, prisma, queue } = build({});

    const result = await controller.triggerSync('ch-1', user, dto);

    expect(prisma.channel.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ch-1',
        organizationId: 'org-1',
        syncStatus: { not: SyncStatus.IN_PROGRESS },
      },
      data: { syncStatus: SyncStatus.IN_PROGRESS },
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    // Claimed BEFORE the job exists, so a worker can never finish first and
    // have its final status overwritten by the claim.
    expect(prisma.channel.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      queue.add.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({ jobId: 'job-1', channelId: 'ch-1' });
  });

  it('refuses a second trigger while a job for the channel is still queued', async () => {
    const { controller, queue } = build({
      syncStatus: SyncStatus.IN_PROGRESS,
      claimCount: 0,
      queuedJobs: [{ data: { channelId: 'ch-1', entityTypes: [] } }],
    });

    await expect(controller.triggerSync('ch-1', user, dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses while a run has a recent IN_PROGRESS sync log', async () => {
    const { controller, queue } = build({
      syncStatus: SyncStatus.IN_PROGRESS,
      claimCount: 0,
      latestLogStartedAt: new Date(),
    });

    await expect(controller.triggerSync('ch-1', user, dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not count another channel\'s job or a setup job as live', async () => {
    const { controller, queue } = build({
      syncStatus: SyncStatus.IN_PROGRESS,
      claimCount: 0,
      queuedJobs: [
        { data: { channelId: 'ch-other', entityTypes: [] } },
        { data: { type: 'setup', channelId: 'ch-1' } },
      ],
    });

    await controller.triggerSync('ch-1', user, dto);

    // Pinned with nothing live → taken over.
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the job cannot be queued', async () => {
    const { controller, prisma } = build({
      syncStatus: SyncStatus.FAILED,
      addRejects: true,
    });

    await expect(controller.triggerSync('ch-1', user, dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.channel.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ch-1', syncStatus: SyncStatus.IN_PROGRESS },
      data: { syncStatus: SyncStatus.FAILED },
    });
  });

  it('leaves a MANUAL channel unclaimed and still queues its push', async () => {
    const { controller, prisma, queue } = build({ platform: ChannelPlatform.MANUAL });

    await controller.triggerSync('ch-1', user, dto);

    expect(prisma.channel.updateMany).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
