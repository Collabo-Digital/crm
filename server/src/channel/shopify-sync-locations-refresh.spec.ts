import { ChannelPlatform } from '@prisma/client';
import { ShopifySyncService } from './shopify-sync.service';

/**
 * Every finished sync re-reads the store's Shopify locations, so one added in
 * Shopify since shows up as waiting for the merchant's decision — without the
 * merchant having to ask for a locations sync.
 */

const ORG = 'org_1';

function build(opts: { locationsSwitchedOff?: boolean; refreshFails?: boolean } = {}) {
  const prisma = {
    channel: {
      findUnique: jest.fn().mockResolvedValue({ id: 'ch_shop', platform: ChannelPlatform.SHOPIFY }),
      update: jest.fn().mockResolvedValue({}),
    },
    channelSyncState: {
      findMany: jest.fn(async ({ where }: any) =>
        where.enabled === false && opts.locationsSwitchedOff ? [{ entityType: 'locations' }] : [],
      ),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const locationSync = {
    syncLocations: opts.refreshFails
      ? jest.fn().mockRejectedValue(new Error('read_locations missing'))
      : jest.fn().mockResolvedValue(undefined),
  };
  // prisma, shopifyOAuth, loyalty, graphql, pushEnqueuer, inventoryLedger,
  // locationSync, config, invoiceService, orgSettings, fx, draftMirrorQueue, commerceEvents
  const service = new ShopifySyncService(
    prisma as any,
    { getAccessToken: jest.fn().mockResolvedValue({ token: 't', shopDomain: 'acme.myshopify.com' }) } as any,
    {} as any, {} as any, {} as any, {} as any,
    locationSync as any,
    { get: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  return { service, locationSync, prisma };
}

describe('ShopifySyncService — the store’s locations after a sync', () => {
  it('are re-read when a sync that did not include them finishes', async () => {
    const { service, locationSync } = build();

    await service.runSync('ch_shop', ORG, []);

    expect(locationSync.syncLocations).toHaveBeenCalledTimes(1);
    expect(locationSync.syncLocations).toHaveBeenCalledWith('ch_shop', ORG, expect.any(Function));
  });

  it('are read once when the sync included them', async () => {
    const { service, locationSync } = build();

    await service.runSync('ch_shop', ORG, ['locations']);

    expect(locationSync.syncLocations).toHaveBeenCalledTimes(1);
  });

  it('are left alone when the merchant switched the locations pull off', async () => {
    const { service, locationSync } = build({ locationsSwitchedOff: true });

    await service.runSync('ch_shop', ORG, []);

    expect(locationSync.syncLocations).not.toHaveBeenCalled();
  });

  it('do not fail the sync when Shopify cannot be read', async () => {
    const { service, prisma } = build({ refreshFails: true });

    await expect(service.runSync('ch_shop', ORG, [])).resolves.toBeUndefined();
    expect(prisma.channel.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ syncStatus: 'COMPLETED' }) }),
    );
  });
});
