import { ServiceUnavailableException } from '@nestjs/common';
import { ChannelPlatform, ChannelStatus } from '@prisma/client';
import { ProductService } from './product.service';
import {
  QUEUE_UNAVAILABLE_ERROR,
  STALE_PENDING_SYNC_MS,
} from '../channel/shopify-push.service';

/**
 * A product is "Syncing" while metadata.shopifySync.status is PENDING. These
 * pin the rules that stop it staying there for ever: the claim is written
 * before the job exists, a queue outage is recorded as a failure, a claim
 * nobody is working can be retried, and a product is never queued twice.
 */
describe('ProductService — Shopify push claim', () => {
  const ORG = 'org-1';

  function build(opts: {
    metadata?: Record<string, unknown> | null;
    claimWins?: boolean;
    enqueueOk?: boolean;
    bulkRows?: Array<{ id: string; metadata: Record<string, unknown> | null }>;
  }) {
    const prisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'p1',
          vendor: null,
          metadata: opts.metadata ?? null,
          channel: { platform: ChannelPlatform.MANUAL },
        }),
        findMany: jest.fn().mockResolvedValue(opts.bulkRows ?? []),
      },
      channel: {
        findFirst: jest.fn().mockResolvedValue({ status: ChannelStatus.CONNECTED }),
      },
      // mergeJsonMetadata runs the claim as a raw UPDATE; the row count is
      // whether the guard let it through.
      $executeRaw: jest.fn().mockResolvedValue(opts.claimWins === false ? 0 : 1),
    };
    const enqueuer = {
      enqueueProductPush: jest.fn().mockResolvedValue(opts.enqueueOk !== false),
    };
    const pushService = {
      recordProductFailure: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ProductService(
      prisma as never,
      enqueuer as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      pushService as never,
    );
    return { service, prisma, enqueuer, pushService };
  }

  /** The JSON patch the claim sent to the database. */
  function claimPatch(prisma: { $executeRaw: jest.Mock }) {
    const values = prisma.$executeRaw.mock.calls[0].slice(1) as unknown[];
    const json = values.find(
      (v) => typeof v === 'string' && v.includes('shopifySync'),
    ) as string;
    return JSON.parse(json).shopifySync as Record<string, unknown>;
  }

  it('claims the product before the job exists', async () => {
    const { service, prisma, enqueuer } = build({});

    await expect(service.syncToShopify('p1', ORG)).resolves.toEqual({
      status: 'QUEUED',
      productId: 'p1',
    });

    // A worker that finishes first can no longer have its result overwritten.
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      enqueuer.enqueueProductPush.mock.invocationCallOrder[0],
    );
    const patch = claimPatch(prisma);
    expect(patch.status).toBe('PENDING');
    expect(typeof patch.queuedAt).toBe('string');
  });

  it('keeps the Shopify product id through a re-push', async () => {
    const { service, prisma } = build({
      metadata: { shopifySync: { status: 'OUT_OF_SYNC', shopifyProductId: 'gid-9', attempts: 1 } },
    });

    await service.syncToShopify('p1', ORG);

    expect(claimPatch(prisma).shopifyProductId).toBe('gid-9');
  });

  it('records a failure and answers 503 when the queue is unavailable', async () => {
    const { service, pushService } = build({ enqueueOk: false });

    await expect(service.syncToShopify('p1', ORG)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Not left PENDING with no job behind it.
    expect(pushService.recordProductFailure).toHaveBeenCalledWith(
      'p1',
      ORG,
      QUEUE_UNAVAILABLE_ERROR,
      false,
    );
  });

  it('does not queue again while a push is in flight', async () => {
    const { service, prisma, enqueuer } = build({
      metadata: {
        shopifySync: { status: 'PENDING', attempts: 0, queuedAt: new Date().toISOString() },
      },
    });

    await expect(service.syncToShopify('p1', ORG)).resolves.toMatchObject({
      status: 'ALREADY_QUEUED',
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(enqueuer.enqueueProductPush).not.toHaveBeenCalled();
  });

  it('lets an abandoned claim be retried', async () => {
    const old = new Date(Date.now() - STALE_PENDING_SYNC_MS - 1000).toISOString();
    const { service, enqueuer } = build({
      metadata: { shopifySync: { status: 'PENDING', attempts: 0, queuedAt: old } },
    });

    await expect(service.syncToShopify('p1', ORG)).resolves.toMatchObject({
      status: 'QUEUED',
    });
    expect(enqueuer.enqueueProductPush).toHaveBeenCalledTimes(1);
  });

  it('treats a claim stamped before queuedAt existed as abandoned', async () => {
    const { service, enqueuer } = build({
      metadata: { shopifySync: { status: 'PENDING', attempts: 0 } },
    });

    await expect(service.syncToShopify('p1', ORG)).resolves.toMatchObject({
      status: 'QUEUED',
    });
    expect(enqueuer.enqueueProductPush).toHaveBeenCalledTimes(1);
  });

  it('queues nothing when a worker marked the product SYNCED first', async () => {
    const { service, enqueuer } = build({
      metadata: { shopifySync: { status: 'FAILED', attempts: 1 } },
      claimWins: false,
    });

    await expect(service.syncToShopify('p1', ORG)).resolves.toMatchObject({
      status: 'ALREADY_SYNCED',
    });
    expect(enqueuer.enqueueProductPush).not.toHaveBeenCalled();
  });

  it('bulk sync reports each product it could not queue', async () => {
    const fresh = new Date().toISOString();
    const rows = [
      { id: 'a', metadata: null },
      { id: 'b', metadata: { shopifySync: { status: 'SYNCED', attempts: 1 } } },
      { id: 'c', metadata: { shopifySync: { status: 'PENDING', attempts: 0, queuedAt: fresh } } },
    ];
    const { service, prisma, enqueuer } = build({ bulkRows: rows });
    // resolveBulkTargets and the metadata read both go through findMany.
    prisma.product.findMany.mockResolvedValue(rows);

    const result = await service.bulkSync(ORG, ['a', 'b', 'c']);

    expect(result.queued).toBe(1);
    expect(result.ok).toEqual(['a']);
    expect(result.skipped).toEqual([
      { id: 'b', reason: 'Already synced to Shopify' },
      { id: 'c', reason: 'Sync already in progress' },
    ]);
    expect(enqueuer.enqueueProductPush).toHaveBeenCalledTimes(1);
  });
});
