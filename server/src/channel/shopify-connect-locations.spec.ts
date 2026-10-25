import { ChannelController } from './channel.controller';

/**
 * Connecting a store no longer maps its locations. With stock locations on,
 * the store's locations are recorded as waiting for the merchant's decision,
 * the first sync leaves out `locations` and `inventory`, and the merchant
 * lands on the channels page told that decisions are waiting.
 */

type Outcome = { warehousing: boolean; recorded: boolean; pending: boolean; linked: boolean };

function build(outcome: Outcome) {
  const syncQueue = { add: jest.fn().mockResolvedValue({ id: 'job_1' }) };
  const shopifyOAuth = {
    handleCallback: jest.fn().mockResolvedValue({
      channelId: 'ch_1',
      organizationId: 'org_1',
      redirectUrl: 'http://app/settings/channels?connected=shopify&channelId=ch_1',
    }),
    manualConnect: jest.fn().mockResolvedValue({ channelId: 'ch_1' }),
  };
  const locationDecisions = { onConnect: jest.fn().mockResolvedValue(outcome) };
  const controller = new ChannelController(
    {} as never,
    {} as never,
    shopifyOAuth as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { get: jest.fn().mockReturnValue('http://app') } as never,
    {} as never,
    syncQueue as never,
    locationDecisions as never,
  );
  const res = { redirect: jest.fn() };
  const syncedEntities = () =>
    syncQueue.add.mock.calls.filter(([name]) => name === 'sync').map(([, data]) => data.entityTypes);
  return { controller, res, syncedEntities, locationDecisions };
}

const query = { code: 'c', hmac: 'h', shop: 'acme.myshopify.com', state: 's', timestamp: '1' };

describe('connecting a Shopify store', () => {
  it('leaves the locations waiting, syncs everything else, and says so on landing', async () => {
    const { controller, res, syncedEntities, locationDecisions } = build({ warehousing: true, recorded: true, pending: true, linked: false });

    await controller.shopifyCallback(query, res as never);

    expect(locationDecisions.onConnect).toHaveBeenCalledWith('ch_1', 'org_1');
    expect(syncedEntities()).toEqual([['products', 'orders', 'customers']]);
    expect(res.redirect).toHaveBeenCalledWith(
      'http://app/settings/channels?connected=shopify&channelId=ch_1&locations=pending',
    );
  });

  it('does the same for a store connected by hand', async () => {
    const { controller, syncedEntities } = build({ warehousing: true, recorded: true, pending: true, linked: false });

    await controller.manualConnectShopify({ sub: 'u_1', orgId: 'org_1' } as never, {} as never);

    expect(syncedEntities()).toEqual([['products', 'orders', 'customers']]);
  });

  it('a reconnect whose locations are decided pulls their stock and waits for nothing', async () => {
    const { controller, res, syncedEntities } = build({ warehousing: true, recorded: true, pending: false, linked: true });

    await controller.shopifyCallback(query, res as never);

    expect(syncedEntities()).toEqual([['products', 'orders', 'customers', 'inventory']]);
    expect(res.redirect).toHaveBeenCalledWith('http://app/settings/channels?connected=shopify&channelId=ch_1');
  });

  it('has the first sync read the locations when they could not be read on connect', async () => {
    const { controller, syncedEntities } = build({ warehousing: true, recorded: false, pending: false, linked: false });

    await controller.shopifyCallback(query, { redirect: jest.fn() } as never);

    expect(syncedEntities()).toEqual([['locations', 'products', 'orders', 'customers']]);
  });

  it('syncs a workspace still on a single stock quantity as before', async () => {
    const { controller, syncedEntities } = build({ warehousing: false, recorded: false, pending: false, linked: false });

    await controller.shopifyCallback(query, { redirect: jest.fn() } as never);

    expect(syncedEntities()).toEqual([['locations', 'products', 'orders', 'customers', 'inventory']]);
  });
});
