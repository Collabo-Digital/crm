import { ShopifyOAuthService } from './shopify-oauth.service';

/**
 * The org's one SHOPIFY channel row is reused when a store is connected again.
 * For a DIFFERENT store (a test store swapped for the live one) its saved sync
 * position belonged to the old store, so the new store's first sync only asked
 * for records changed since then and most of its catalogue never arrived.
 */
function build(prev: { externalStoreId: string | null; metadata: unknown }) {
  const tx = {
    channel: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(prev),
      update: jest.fn(async ({ data }: any) => ({ id: 'ch_1', ...data })),
    },
    channelSyncState: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    syncLog: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const config = { get: jest.fn().mockReturnValue('x') };
  const service = new ShopifyOAuthService(
    {} as any, config as any, {} as any, {} as any, {} as any, {} as any,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  return { tx, service };
}

const channelData = {
  name: 'Live store',
  externalStoreId: '2002',
  externalStoreUrl: 'https://live.myshopify.com',
};

describe('ShopifyOAuthService.reuseChannelRow', () => {
  it('resumes where it was for the same store, after a disconnect released the claim', async () => {
    const { tx, service } = build({ externalStoreId: null, metadata: { externalAccountId: '2002' } });

    await (service as any).reuseChannelRow(tx, 'ch_1', channelData);

    expect(tx.channelSyncState.updateMany).not.toHaveBeenCalled();
    expect(tx.syncLog.updateMany).not.toHaveBeenCalled();
    expect(tx.channel.update).toHaveBeenCalledWith({ where: { id: 'ch_1' }, data: channelData });
  });

  it('restarts the pull with a full backfill for a different store, and turns pushes off', async () => {
    const { tx, service } = build({
      externalStoreId: null,
      metadata: { externalAccountId: '1001', shopifyLocationId: 84967948340, lastAccount: { displayName: 'Test' } },
    });

    await (service as any).reuseChannelRow(tx, 'ch_1', channelData);

    expect(tx.channelSyncState.updateMany).toHaveBeenCalledWith({
      where: { channelId: 'ch_1', direction: 'pull' },
      data: { watermark: null, backfillDone: false, windowStart: null },
    });
    expect(tx.channelSyncState.updateMany).toHaveBeenCalledWith({
      where: { channelId: 'ch_1', direction: 'push' },
      data: { enabled: false },
    });
    expect(tx.syncLog.updateMany).toHaveBeenCalledWith({
      where: { channelId: 'ch_1', cursor: { not: null } },
      data: { cursor: null },
    });
    const { data } = tx.channel.update.mock.calls[0][0];
    // The old store's primary location must not receive the new store's fulfilments.
    expect(data.metadata).not.toHaveProperty('shopifyLocationId');
    expect(data.metadata).toMatchObject({ lastAccount: { displayName: 'Test' } });
    expect(data).toMatchObject({ externalStoreId: '2002', lastSyncedAt: null });
  });

  it('treats a row whose previous store is unknown as a different store', async () => {
    const { tx, service } = build({ externalStoreId: null, metadata: null });

    await (service as any).reuseChannelRow(tx, 'ch_1', channelData);

    expect(tx.channelSyncState.updateMany).toHaveBeenCalled();
  });
});
