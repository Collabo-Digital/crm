import { ChannelPlatform } from '@prisma/client';
import { ShopifySyncService } from './shopify-sync.service';

const ORG = 'org_1';

function build(prisma: Record<string, unknown>) {
  const pushEnqueuer = {
    enqueueBulkProductPush: jest.fn().mockResolvedValue(undefined),
    enqueueBulkOrderPush: jest.fn().mockResolvedValue(undefined),
  };
  const draftMirrorQueue = { add: jest.fn().mockResolvedValue(undefined) };
  // prisma, shopifyOAuth, loyalty, graphql, pushEnqueuer, inventoryLedger,
  // locationSync, config, invoiceService, orgSettings, fx, draftMirrorQueue, commerceEvents
  const service = new ShopifySyncService(
    prisma as any, {} as any, {} as any, {} as any, pushEnqueuer as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, draftMirrorQueue as any, {} as any,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
  return { service, pushEnqueuer, draftMirrorQueue };
}

/**
 * A push creates real products and orders in the merchant's live store, and a
 * Shopify order cannot be un-created. Connecting a store with a CRM backlog
 * used to send all of it a few minutes later, before anyone saw the toggles.
 */
describe('ShopifySyncService — the bulk push is opt-in', () => {
  function manualChannelPrisma(pushRows: Array<{ entityType: string }>) {
    return {
      channel: {
        findUnique: jest.fn().mockResolvedValue({ id: 'ch_manual', platform: ChannelPlatform.MANUAL }),
        update: jest.fn().mockResolvedValue({}),
      },
      channelSyncState: {
        findMany: jest.fn(async ({ where }: any) => (where.enabled === true ? pushRows : [])),
      },
    };
  }

  it('pushes nothing for a channel whose push toggles were never switched on', async () => {
    const { service, pushEnqueuer, draftMirrorQueue } = build(manualChannelPrisma([]));

    await service.runSync('ch_manual', ORG, [], undefined, { pushAfter: true });

    expect(pushEnqueuer.enqueueBulkProductPush).not.toHaveBeenCalled();
    expect(pushEnqueuer.enqueueBulkOrderPush).not.toHaveBeenCalled();
    expect(draftMirrorQueue.add).not.toHaveBeenCalled();
  });

  it('pushes exactly what the merchant switched on, on a Sync press', async () => {
    const { service, pushEnqueuer, draftMirrorQueue } = build(
      manualChannelPrisma([{ entityType: 'orders' }]),
    );

    await service.runSync('ch_manual', ORG, [], undefined, { pushAfter: true });

    expect(pushEnqueuer.enqueueBulkOrderPush).toHaveBeenCalledTimes(1);
    expect(pushEnqueuer.enqueueBulkProductPush).not.toHaveBeenCalled();
    expect(draftMirrorQueue.add).not.toHaveBeenCalled();
  });

  it('never pushes from a sync nobody pressed (connect backfill, draft completion)', async () => {
    const { service, pushEnqueuer } = build(
      manualChannelPrisma([{ entityType: 'orders' }, { entityType: 'products' }]),
    );

    await service.runSync('ch_manual', ORG, []);

    expect(pushEnqueuer.enqueueBulkOrderPush).not.toHaveBeenCalled();
    expect(pushEnqueuer.enqueueBulkProductPush).not.toHaveBeenCalled();
  });

  it('pushes nothing when the toggles cannot be read', async () => {
    const prisma = manualChannelPrisma([]);
    prisma.channelSyncState.findMany.mockRejectedValue(new Error('db down'));
    const { service, pushEnqueuer } = build(prisma);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await service.runSync('ch_manual', ORG, [], undefined, { pushAfter: true });

    expect(pushEnqueuer.enqueueBulkOrderPush).not.toHaveBeenCalled();
  });
});

describe('ShopifySyncService — fulfilment status from the GraphQL pull', () => {
  it('maps PARTIALLY_FULFILLED (lowercased by the transform) to PARTIAL', () => {
    const { service } = build({});
    expect((service as any).mapFulfillmentStatus('partially_fulfilled')).toBe('PARTIAL');
    expect((service as any).mapFulfillmentStatus('partial')).toBe('PARTIAL');
    expect((service as any).mapFulfillmentStatus('fulfilled')).toBe('FULFILLED');
    expect((service as any).mapFulfillmentStatus(null)).toBe('UNFULFILLED');
  });
});

describe('ShopifySyncService — out-of-order product and customer webhooks', () => {
  it('skips a products/update older than what is stored', async () => {
    const prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue({ externalUpdatedAt: new Date('2026-10-25T10:00:05Z') }),
        upsert: jest.fn(),
      },
    };
    const { service } = build(prisma);

    await service.upsertProduct('ch', ORG, {
      id: 9, title: 'Old title', updated_at: '2026-10-25T10:00:00Z', variants: [],
    });

    expect(prisma.product.upsert).not.toHaveBeenCalled();
  });

  it('skips a customers/update older than what is stored', async () => {
    const prisma = {
      customer: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(
            where.channelId_externalId
              ? { id: 'row_a', externalUpdatedAt: new Date('2026-10-25T10:00:05Z') }
              : { id: 'row_a' },
          ),
        ),
        update: jest.fn(),
        create: jest.fn(),
      },
    };
    const { service } = build(prisma);
    (service as any).loyalty = { recomputeForCustomer: jest.fn().mockResolvedValue(undefined) };

    await service.upsertCustomer('ch', ORG, {
      id: 555, email: 'ana@example.com', first_name: 'Old', updated_at: '2026-10-25T10:00:00Z',
    });

    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });
});
