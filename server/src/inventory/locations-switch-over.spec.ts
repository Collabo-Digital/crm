import { LocationsSwitchOver } from './locations-switch-over';
import { InventoryService } from './inventory.service';

/**
 * Existing workspaces move to stock locations once, from start-up: one queued
 * job per workspace still without warehousing, under the workspace's own job
 * id, running the same enable flow a merchant's click runs.
 */

function buildSwitchOver(opts: { enabled?: boolean; pending?: string[]; jobs?: Record<string, string> } = {}) {
  const removed: string[] = [];
  const prisma = { $queryRaw: jest.fn().mockResolvedValue((opts.pending ?? []).map((id) => ({ id }))) };
  const queue = {
    getJob: jest.fn(async (id: string) => {
      const state = opts.jobs?.[id];
      return state ? { getState: async () => state, remove: async () => void removed.push(id) } : undefined;
    }),
    add: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: jest.fn().mockReturnValue(opts.enabled ?? true) };
  const switchOver = new LocationsSwitchOver(prisma as any, config as any, queue as any);
  return { switchOver, prisma, queue, removed };
}

describe('LocationsSwitchOver', () => {
  it('queues one switch per workspace without warehousing, under that workspace’s job id', async () => {
    const { switchOver, queue } = buildSwitchOver({ pending: ['org_a', 'org_b'] });

    expect(await switchOver.enqueueAll()).toBe(2);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'switch-over',
      { type: 'switch-over', organizationId: 'org_a' },
      expect.objectContaining({ jobId: 'locations-switch-over-org_a', attempts: 3 }),
    );
  });

  it('leaves a switch already queued or running alone, so several servers starting queue it once', async () => {
    const { switchOver, queue } = buildSwitchOver({
      pending: ['org_a', 'org_b'],
      jobs: { 'locations-switch-over-org_a': 'waiting', 'locations-switch-over-org_b': 'active' },
    });

    expect(await switchOver.enqueueAll()).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('tries a workspace whose switch gave up again on the next start', async () => {
    const { switchOver, queue, removed } = buildSwitchOver({
      pending: ['org_a'],
      jobs: { 'locations-switch-over-org_a': 'failed' },
    });

    expect(await switchOver.enqueueAll()).toBe(1);
    expect(removed).toEqual(['locations-switch-over-org_a']);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('selects only workspaces whose warehousing is not on, and none that are deleted', async () => {
    const { switchOver, prisma } = buildSwitchOver();
    await switchOver.enqueueAll();
    const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/"deleted_at" IS NULL/);
    expect(sql).toMatch(/'warehousingEnabled', 'false'\) <> 'true'/);
  });

  it('does nothing at start-up when LOCATIONS_AUTO_ENABLE is false', async () => {
    const { switchOver, prisma, queue } = buildSwitchOver({ enabled: false, pending: ['org_a'] });

    switchOver.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues at start-up when it is on', async () => {
    const { switchOver, queue } = buildSwitchOver({ pending: ['org_a'] });

    switchOver.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));

    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('InventoryService.runSwitchOver', () => {
  type SeedVariant = { id: string; sku: string; inventoryQuantity: number; trackQuantity: boolean };

  function buildInventory(
    enabled: boolean,
    defaultWarehouse: object | null = null,
    seed: { trackGlobally?: boolean; variants?: SeedVariant[] } = {},
  ) {
    let current = defaultWarehouse;
    const seeded: object[] = [];
    const tx = {
      stockLevel: {
        findMany: jest.fn(() => Promise.resolve([])),
        createMany: jest.fn(({ data }: { data: object[] }) => {
          seeded.push(...data);
          return Promise.resolve({ count: data.length });
        }),
      },
      inventoryEvent: { createMany: jest.fn(() => Promise.resolve({ count: 0 })) },
    };
    const prisma = {
      warehouse: {
        findFirst: jest.fn(async () => current),
        create: jest.fn(async ({ data }: any) => (current = { id: 'wh_main', ...data })),
      },
      channel: { findFirst: jest.fn().mockResolvedValue({ metadata: { shopifyLocationId: 111 } }) },
      productVariant: {
        // One page holds every variant here; the page after it is empty.
        findMany: jest.fn(({ where, cursor }: { where: { trackQuantity?: boolean }; cursor?: object }) =>
          Promise.resolve(
            cursor
              ? []
              : (seed.variants ?? []).filter(
                  (v) => where.trackQuantity === undefined || v.trackQuantity === where.trackQuantity,
                ),
          ),
        ),
      },
      $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const settings = {
      getInventorySettings: jest.fn().mockResolvedValue({ warehousingEnabled: enabled }),
      getProductSettings: jest.fn().mockResolvedValue({ trackQuantityGlobally: seed.trackGlobally ?? false }),
      setWarehousingEnabled: jest.fn().mockResolvedValue(undefined),
    };
    const ledger = { invalidateFlagCache: jest.fn() };
    const pushQueue = { getJob: jest.fn().mockResolvedValue(undefined), add: jest.fn().mockResolvedValue(undefined) };
    const service = new InventoryService(
      prisma as any,
      settings as any,
      ledger as any,
      {} as any,
      { add: jest.fn() } as any,
      pushQueue as any,
    );
    return { service, prisma, settings, pushQueue, seeded };
  }

  it('is a no-op for a workspace already switched — a left-over job changes nothing', async () => {
    const { service, prisma, settings } = buildInventory(true);

    await service.runSwitchOver('org_a');

    expect(prisma.warehouse.create).not.toHaveBeenCalled();
    expect(settings.setWarehousingEnabled).not.toHaveBeenCalled();
  });

  it('runs the enable flow: the Main warehouse on the store’s primary location, the seed, then the flag', async () => {
    const { service, prisma, settings, pushQueue } = buildInventory(false);

    await service.runSwitchOver('org_a');

    expect(prisma.warehouse.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Main warehouse',
        code: 'WH1',
        kind: 'WAREHOUSE',
        isDefault: true,
        shopifyLocationId: '111',
      }),
    });
    // Marked so a later sync links the store if the job below fails.
    expect(settings.setWarehousingEnabled).toHaveBeenCalledWith('org_a', true, { linkShopifyLocations: true });
    // The store's other locations are then linked as before, and recorded as decided.
    expect(pushQueue.add).toHaveBeenCalledWith(
      'sync-locations',
      expect.objectContaining({ type: 'sync-locations', organizationId: 'org_a', autoLink: true }),
      expect.objectContaining({ jobId: 'sync-locations-org_a' }),
    );
  });

  it('reuses a default location a previous attempt already made', async () => {
    const { service, prisma, settings } = buildInventory(false, { id: 'wh_existing' });

    await service.runSwitchOver('org_a');

    expect(prisma.warehouse.create).not.toHaveBeenCalled();
    expect(settings.setWarehousingEnabled).toHaveBeenCalledWith('org_a', true, { linkShopifyLocations: true });
  });

  it('marks nothing to link for a workspace with no Shopify store', async () => {
    const { service, prisma, settings } = buildInventory(false);
    prisma.channel.findFirst.mockResolvedValue(null);

    await service.runSwitchOver('org_a');

    expect(settings.setWarehousingEnabled).toHaveBeenCalledWith('org_a', true, { linkShopifyLocations: false });
  });

  const untrackedTee = { id: 'v1', sku: 'TEE-1', inventoryQuantity: 20, trackQuantity: false };

  it('seeds a variant whose own switch is off when the workspace tracks every variant', async () => {
    const { service, seeded } = buildInventory(false, null, { trackGlobally: true, variants: [untrackedTee] });

    await service.runSwitchOver('org_a');

    // Sales count it as tracked. Without this row its first sale of 2 is
    // taken from an empty one, leaving -2 where 20 were.
    expect(seeded).toEqual([{ organizationId: 'org_a', variantId: 'v1', warehouseId: 'wh_main', available: 20 }]);
  });

  it('leaves that variant out when the workspace tracks per variant', async () => {
    const { service, seeded } = buildInventory(false, null, { variants: [untrackedTee] });

    await service.runSwitchOver('org_a');

    expect(seeded).toEqual([]);
  });
});
