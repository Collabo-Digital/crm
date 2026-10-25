import { BadRequestException } from '@nestjs/common';
import { ShopifyLocationSyncService } from './shopify-location-sync.service';
import { ShopifyLocationDecisionService } from './shopify-location-decision.service';
import { LocationLinkService } from '../inventory/location-links.service';

/**
 * Connecting Shopify no longer maps its locations by itself. Each Shopify
 * location waits for the merchant to decide: share stock with a Collabo
 * location, create a new one, or leave it out — and a sync never makes that
 * decision for them, except the one-time enable flow, which links an existing
 * store as it always was.
 *
 * Run against a small in-memory stand-in for the two tables involved, so the
 * assertions read as the state the merchant would see.
 */

const ORG = 'org_1';
const CHANNEL = 'ch_1';

type Row = Record<string, any>;

/** `where` as the services write it: equality, `not`, `in`, `notIn`. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'channel') return true; // the store is always this connected one
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if ('not' in want) return row[key] !== want.not;
      if ('in' in want) return want.in.includes(row[key]);
      if ('notIn' in want) return !want.notIn.includes(row[key]);
      return false;
    }
    return want === undefined || row[key] === want;
  });
}
const defined = (data: Row) => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

function fakeDb(init: { warehouses?: Row[]; records?: Row[]; gstins?: Row[]; gstEnabled?: boolean; stocked?: string[]; linkPending?: boolean }) {
  const settings: { inventorySettings: Row } = {
    inventorySettings: { warehousingEnabled: true, linkShopifyLocations: init.linkPending ?? false },
  };
  const warehouses: Row[] = (init.warehouses ?? []).map((w) => ({
    organizationId: ORG,
    kind: 'WAREHOUSE',
    shopifyLocationId: null,
    isDefault: false,
    isActive: true,
    address: null,
    gstinId: null,
    createdAt: new Date(),
    ...w,
  }));
  const records: Row[] = (init.records ?? []).map((r) => ({
    id: `rec_${r.shopifyLocationId}`,
    organizationId: ORG,
    channelId: CHANNEL,
    isPrimary: false,
    isActive: true,
    address: null,
    action: null,
    warehouseId: null,
    decidedAt: null,
    ...r,
  }));
  const gstins: Row[] = (init.gstins ?? []).map((g) => ({ organizationId: ORG, isActive: true, isDefault: false, ...g }));
  let seq = 0;
  const db: any = {
    warehouse: {
      findMany: jest.fn(async ({ where }: any = {}) => warehouses.filter((w) => matches(w, where))),
      findFirst: jest.fn(async ({ where }: any) => warehouses.find((w) => matches(w, where)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        if (data.shopifyLocationId && warehouses.some((w) => w.shopifyLocationId === data.shopifyLocationId)) {
          throw new Error('unique violation');
        }
        const row = { organizationId: ORG, shopifyLocationId: null, isDefault: false, isActive: true, gstinId: null, address: null, kind: 'WAREHOUSE', createdAt: new Date(), id: `wh_new_${++seq}`, ...defined(data) };
        warehouses.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(warehouses.find((w) => w.id === where.id)!, defined(data))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = warehouses.filter((w) => matches(w, where));
        hit.forEach((w) => Object.assign(w, defined(data)));
        return { count: hit.length };
      }),
    },
    shopifyLocationLink: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = where.channelId_shopifyLocationId;
        const found = records.find((r) => r.channelId === key.channelId && r.shopifyLocationId === key.shopifyLocationId);
        if (found) return Object.assign(found, defined(update));
        const row = { id: `rec_${create.shopifyLocationId}`, action: null, warehouseId: null, decidedAt: null, ...create };
        records.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => records.find((r) => matches(r, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => records.filter((r) => matches(r, where))),
      update: jest.fn(async ({ where, data }: any) => Object.assign(records.find((r) => r.id === where.id)!, defined(data))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        records.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, defined(data)));
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        for (const r of records.filter((x) => matches(x, where))) records.splice(records.indexOf(r), 1);
      }),
    },
    organization: { findUnique: jest.fn(async () => ({ gstEnabled: init.gstEnabled ?? false })) },
    organizationSettings: {
      findUnique: jest.fn(async () => settings),
      update: jest.fn(async ({ data }: any) => Object.assign(settings, data)),
    },
    organizationGstin: { findFirst: jest.fn(async ({ where }: any) => gstins.find((g) => matches(g, where)) ?? null) },
    stockLevel: { groupBy: jest.fn(async () => (init.stocked ?? []).map((warehouseId) => ({ warehouseId }))) },
    syncLog: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'log_1', cursor: null })),
      update: jest.fn(async () => ({})),
    },
    channel: {
      findFirst: jest.fn(async () => ({ id: CHANNEL, status: 'CONNECTED' })),
      findUnique: jest.fn(async () => ({ metadata: {} })),
      update: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (fn: any) => fn(db)),
  };
  return { db, warehouses, records, settings };
}

const node = (id: string, name: string, over: Partial<{ isPrimary: boolean; isActive: boolean; stateCode: string }> = {}) => ({
  id: `gid://shopify/Location/${id}`,
  name,
  isActive: over.isActive ?? true,
  isPrimary: over.isPrimary ?? false,
  address: over.stateCode
    ? { address1: '1 Main Rd', address2: null, city: 'Kochi', province: 'Kerala', provinceCode: 'KL', zip: '682001', country: 'India', countryCode: 'IN', phone: null }
    : null,
});

function build(init: Parameters<typeof fakeDb>[0], nodes: ReturnType<typeof node>[] = []) {
  const { db, warehouses, records, settings } = fakeDb(init);
  const graphql = {
    request: jest.fn(async () => ({ locations: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } })),
  };
  const ledger = { isWarehousingEnabled: jest.fn().mockResolvedValue(true) };
  const oauth = { getAccessToken: jest.fn().mockResolvedValue({ token: 't', shopDomain: 'acme.myshopify.com' }) };
  const locationSync = new ShopifyLocationSyncService(db, graphql as any, oauth as any, ledger as any);
  const pushQueue = { getJob: jest.fn().mockResolvedValue(undefined), add: jest.fn().mockResolvedValue(undefined) };
  const links = new LocationLinkService(pushQueue as any);
  const decisions = new ShopifyLocationDecisionService(db, locationSync, links, ledger as any);
  const sync = (autoLink = false) => locationSync.syncLocations(CHANNEL, ORG, async () => ({ shopDomain: 's', accessToken: 't' }), { autoLink });
  const stockJobs = () => pushQueue.add.mock.calls.map((c) => c[1]);
  return { db, warehouses, records, settings, graphql, locationSync, decisions, sync, stockJobs, ledger, pushQueue, links };
}

const byId = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;
const recordFor = (rows: Row[], shopifyLocationId: string) => rows.find((r) => r.shopifyLocationId === shopifyLocationId)!;

describe('syncing a store’s Shopify locations', () => {
  it('records every location of a newly connected store as waiting, and makes no location of its own', async () => {
    const t = build(
      { warehouses: [{ id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true }] },
      [node('101', 'MG Road shop', { isPrimary: true }), node('102', 'Online')],
    );

    await t.sync();

    expect(t.warehouses).toHaveLength(1);
    expect(t.warehouses[0].shopifyLocationId).toBeNull();
    expect(t.records.map((r) => [r.shopifyLocationId, r.action])).toEqual([['101', null], ['102', null]]);
    const view = await t.decisions.view(CHANNEL, ORG);
    expect(view.status).toBe('PENDING');
    expect(view.locations.map((l) => [l.id, l.isPrimary, l.decision])).toEqual([['101', true, null], ['102', false, null]]);
  });

  it('adds a Shopify location that appears later as needing linking, and leaves the rest alone', async () => {
    const t = build(
      {
        warehouses: [{ id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true, shopifyLocationId: '101' }],
        records: [{ shopifyLocationId: '101', name: 'MG Road shop', action: 'LINK', warehouseId: 'wh_main' }],
      },
      [node('101', 'MG Road shop', { isPrimary: true }), node('103', 'Pop-up')],
    );

    await t.sync();

    expect(t.warehouses).toHaveLength(1);
    expect(byId(t.warehouses, 'wh_main').name).toBe('Main warehouse');
    expect(recordFor(t.records, '103').action).toBeNull();
    expect((await t.decisions.view(CHANNEL, ORG)).status).toBe('PENDING');
  });

  it('never moves the default location to the primary Shopify location', async () => {
    const t = build(
      {
        warehouses: [
          { id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true, shopifyLocationId: '102' },
          { id: 'wh_store', name: 'MG Road', code: 'MG', shopifyLocationId: '101' },
        ],
      },
      [node('101', 'MG Road shop', { isPrimary: true }), node('102', 'Online')],
    );

    await t.sync();

    expect(byId(t.warehouses, 'wh_main').isDefault).toBe(true);
    expect(byId(t.warehouses, 'wh_store').isDefault).toBe(false);
    // Links made before decisions were recorded are recorded as decided.
    expect(recordFor(t.records, '101')).toEqual(expect.objectContaining({ action: 'LINK', warehouseId: 'wh_store' }));
    expect((await t.decisions.view(CHANNEL, ORG)).status).toBe('DONE');
  });

  it('takes Shopify’s name only for a location created from Shopify', async () => {
    const t = build(
      {
        warehouses: [
          { id: 'wh_created', name: 'Old name', code: 'OLD', shopifyLocationId: '101' },
          { id: 'wh_mine', name: 'Kochi store', code: 'KO', shopifyLocationId: '102' },
        ],
        records: [
          { shopifyLocationId: '101', name: 'Old name', action: 'CREATE', warehouseId: 'wh_created' },
          { shopifyLocationId: '102', name: 'Kochi', action: 'LINK', warehouseId: 'wh_mine' },
        ],
      },
      [node('101', 'New name', { isPrimary: true }), node('102', 'Kochi renamed')],
    );

    await t.sync();

    expect(byId(t.warehouses, 'wh_created').name).toBe('New name');
    expect(byId(t.warehouses, 'wh_mine').name).toBe('Kochi store');
    expect(recordFor(t.records, '102').name).toBe('Kochi renamed');
  });

  it('switches a linked location off with its Shopify location, but never the default', async () => {
    const t = build(
      {
        warehouses: [
          { id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true, shopifyLocationId: '101' },
          { id: 'wh_store', name: 'Kochi store', code: 'KO', shopifyLocationId: '102' },
        ],
      },
      [node('101', 'MG Road', { isPrimary: true, isActive: false }), node('102', 'Kochi', { isActive: false })],
    );

    await t.sync();

    expect(byId(t.warehouses, 'wh_main').isActive).toBe(true);
    expect(byId(t.warehouses, 'wh_store').isActive).toBe(false);
  });

  it('deactivates the location linked to a Shopify location that was removed — not the default — and forgets the location', async () => {
    const t = build(
      {
        warehouses: [
          { id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true, shopifyLocationId: '109' },
          { id: 'wh_gone', name: 'Closed shop', code: 'CL', shopifyLocationId: '108' },
        ],
        records: [
          { shopifyLocationId: '108', name: 'Closed shop', action: 'LINK', warehouseId: 'wh_gone' },
          { shopifyLocationId: '109', name: 'Old primary', action: 'LINK', warehouseId: 'wh_main' },
        ],
      },
      [node('101', 'MG Road', { isPrimary: true })],
    );

    await t.sync();

    expect(byId(t.warehouses, 'wh_gone').isActive).toBe(false);
    expect(byId(t.warehouses, 'wh_main').isActive).toBe(true);
    expect(t.records.map((r) => r.shopifyLocationId)).toEqual(['101']);
  });

  it('a location unlinked since waits for a decision again', async () => {
    const t = build(
      {
        warehouses: [{ id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true }],
        records: [{ shopifyLocationId: '101', name: 'MG Road', action: 'LINK', warehouseId: 'wh_main' }],
      },
      [node('101', 'MG Road', { isPrimary: true })],
    );

    await t.sync();

    expect(recordFor(t.records, '101')).toEqual(expect.objectContaining({ action: null, warehouseId: null }));
  });

  it('the enable flow links an existing store as before and records it as decided', async () => {
    const t = build(
      {
        warehouses: [{ id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true }],
        records: [{ shopifyLocationId: '103', name: 'Warehouse B', action: 'IGNORE' }],
        gstins: [{ id: 'g_kl', stateCode: '32' }],
        gstEnabled: true,
      },
      [node('101', 'MG Road shop', { isPrimary: true }), node('102', 'Kochi', { stateCode: '32' }), node('103', 'Warehouse B')],
    );

    await t.sync(true);

    // The primary shares the Main warehouse's stock…
    expect(byId(t.warehouses, 'wh_main')).toEqual(expect.objectContaining({ shopifyLocationId: '101', isDefault: true }));
    expect(recordFor(t.records, '101')).toEqual(expect.objectContaining({ action: 'LINK', warehouseId: 'wh_main' }));
    // …every other one gets a Warehouse of its own, with its state's GSTIN…
    const kochi = t.warehouses.find((w) => w.shopifyLocationId === '102')!;
    expect(kochi).toEqual(expect.objectContaining({ name: 'Kochi', kind: 'WAREHOUSE', isDefault: false, gstinId: 'g_kl' }));
    expect(recordFor(t.records, '102')).toEqual(expect.objectContaining({ action: 'CREATE', warehouseId: kochi.id }));
    // …and one the merchant left out stays out.
    expect(t.warehouses.some((w) => w.shopifyLocationId === '103')).toBe(false);
    expect((await t.decisions.view(CHANNEL, ORG)).status).toBe('DONE');
  });
});

describe('the enable flow’s linking, until it has happened', () => {
  const legacyStore = () =>
    build(
      {
        // Pre-linked from the primary id cached on the channel at enable time.
        warehouses: [{ id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true, shopifyLocationId: '101' }],
        linkPending: true,
      },
      [node('101', 'MG Road shop', { isPrimary: true }), node('102', 'Kochi')],
    );

  it('is done by any later locations sync when the enable flow’s own one failed, and then cleared', async () => {
    const t = legacyStore();

    await t.sync(); // an ordinary sync, not the enable job

    expect(t.warehouses.find((w) => w.shopifyLocationId === '102')).toEqual(expect.objectContaining({ name: 'Kochi', kind: 'WAREHOUSE' }));
    // The pre-linked default takes the Shopify name, as it always did.
    expect(byId(t.warehouses, 'wh_main').name).toBe('MG Road shop');
    expect(t.settings.inventorySettings.linkShopifyLocations).toBe(false);
  });

  it('happens once: a sync after it links nothing new', async () => {
    const t = legacyStore();
    await t.sync();
    t.graphql.request.mockResolvedValue({
      locations: { nodes: [node('101', 'MG Road shop', { isPrimary: true }), node('102', 'Kochi'), node('103', 'Pop-up')], pageInfo: { hasNextPage: false, endCursor: null } },
    });

    await t.sync();

    expect(t.warehouses.some((w) => w.shopifyLocationId === '103')).toBe(false);
    expect(recordFor(t.records, '103').action).toBeNull();
  });

  it('is kept for the next sync when Shopify cannot be read', async () => {
    const t = legacyStore();
    t.graphql.request.mockRejectedValue(new Error('502'));

    await expect(t.sync()).rejects.toThrow('502');

    expect(t.settings.inventorySettings.linkShopifyLocations).toBe(true);
  });
});

describe('queueing the stock sync for newly linked locations', () => {
  const job = (state: string, data: Row = { type: 'sync-locations', organizationId: ORG, pushWarehouseIds: ['wh_a'] }) => ({
    data,
    getState: jest.fn().mockResolvedValue(state),
    updateData: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  });

  it('adds the locations to a job still waiting, so two pulls never run together', async () => {
    const t = build({});
    const waiting = job('waiting', { type: 'sync-locations', organizationId: ORG, autoLink: true, pushWarehouseIds: ['wh_a'] });
    t.pushQueue.getJob.mockImplementation(async (id: string) => (id === `sync-locations-${ORG}` ? waiting : undefined));

    await t.links.queueStockSync(ORG, ['wh_b']);

    expect(waiting.updateData).toHaveBeenCalledWith({ type: 'sync-locations', organizationId: ORG, autoLink: true, pushWarehouseIds: ['wh_a', 'wh_b'] });
    expect(t.pushQueue.add).not.toHaveBeenCalled();
  });

  it('queues one follow-up, started later, behind a job already running', async () => {
    const t = build({});
    t.pushQueue.getJob.mockImplementation(async (id: string) => (id === `sync-locations-${ORG}` ? job('active') : undefined));

    await t.links.queueStockSync(ORG, ['wh_b']);

    expect(t.pushQueue.add).toHaveBeenCalledWith(
      'sync-locations',
      expect.objectContaining({ pushWarehouseIds: ['wh_b'] }),
      expect.objectContaining({ jobId: `sync-locations-${ORG}-next`, delay: expect.any(Number) }),
    );
  });

  it('replaces a finished job under the same id', async () => {
    const t = build({});
    const done = job('completed');
    t.pushQueue.getJob.mockImplementation(async (id: string) => (id === `sync-locations-${ORG}` ? done : undefined));

    await t.links.queueStockSync(ORG, []);

    expect(done.remove).toHaveBeenCalled();
    expect(t.pushQueue.add).toHaveBeenCalledWith('sync-locations', expect.anything(), expect.objectContaining({ jobId: `sync-locations-${ORG}` }));
  });
});

describe('applying the merchant’s decisions', () => {
  const store = () =>
    build(
      {
        warehouses: [
          { id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true },
          { id: 'wh_kochi', name: 'Kochi store', code: 'KO', kind: 'STORE' },
        ],
        records: [
          { shopifyLocationId: '101', name: 'MG Road shop', isPrimary: true },
          { shopifyLocationId: '102', name: 'Online', address: { city: 'Kochi', stateCode: '32' } },
          { shopifyLocationId: '103', name: 'Warehouse B' },
        ],
        gstins: [{ id: 'g_kl', stateCode: '32' }],
        gstEnabled: true,
        stocked: ['wh_main'],
      },
    );

  it('links a location keeping Shopify’s counts: linked, decided, then pulled from Shopify', async () => {
    const t = store();

    const view = await t.decisions.apply(CHANNEL, ORG, {
      decisions: [{ shopifyLocationId: '101', action: 'link', warehouseId: 'wh_main', stockSource: 'shopify' }],
    });

    expect(byId(t.warehouses, 'wh_main').shopifyLocationId).toBe('101');
    expect(view.locations.find((l) => l.id === '101')!.decision).toEqual({ action: 'link', warehouseId: 'wh_main', warehouseName: 'Main warehouse' });
    expect(view.status).toBe('PENDING');
    expect(t.stockJobs()).toEqual([expect.objectContaining({ type: 'sync-locations', organizationId: ORG, pushWarehouseIds: [] })]);
    expect(view.warehouses.find((w) => w.id === 'wh_main')).toEqual({ id: 'wh_main', name: 'Main warehouse', kind: 'WAREHOUSE', isDefault: true, hasStock: true, shopifyLocationId: '101' });
  });

  it('links a location keeping Collabo’s counts: they are sent to Shopify before the pull', async () => {
    const t = store();

    await t.decisions.apply(CHANNEL, ORG, {
      decisions: [{ shopifyLocationId: '101', action: 'link', warehouseId: 'wh_main', stockSource: 'collabo' }],
    });

    expect(t.stockJobs()).toEqual([expect.objectContaining({ pushWarehouseIds: ['wh_main'] })]);
  });

  it('creates a new location for a Shopify location: named, of the kind asked, its address and its state’s GSTIN', async () => {
    const t = store();

    const view = await t.decisions.apply(CHANNEL, ORG, {
      decisions: [{ shopifyLocationId: '102', action: 'create', kind: 'STORE', name: 'Online store' }],
    });

    const created = t.warehouses.find((w) => w.shopifyLocationId === '102')!;
    expect(created).toEqual(expect.objectContaining({ name: 'Online store', kind: 'STORE', code: 'ONLINE', gstinId: 'g_kl', isDefault: false }));
    expect(created.address).toEqual({ city: 'Kochi', stateCode: '32' });
    expect(view.locations.find((l) => l.id === '102')!.decision).toEqual({ action: 'create', warehouseId: created.id, warehouseName: 'Online store' });
    expect(t.stockJobs()).toEqual([expect.objectContaining({ pushWarehouseIds: [] })]);
  });

  it('leaves a location out: never synced, and unlinked if it shared stock', async () => {
    const t = store();
    await t.decisions.apply(CHANNEL, ORG, {
      decisions: [{ shopifyLocationId: '103', action: 'link', warehouseId: 'wh_kochi', stockSource: 'shopify' }],
    });

    const view = await t.decisions.apply(CHANNEL, ORG, {
      decisions: [{ shopifyLocationId: '103', action: 'ignore' }],
    });

    expect(byId(t.warehouses, 'wh_kochi').shopifyLocationId).toBeNull();
    expect(view.locations.find((l) => l.id === '103')!.decision).toEqual({ action: 'ignore' });
  });

  it('is DONE once every active Shopify location is decided', async () => {
    const t = store();

    const view = await t.decisions.apply(CHANNEL, ORG, {
      decisions: [
        { shopifyLocationId: '101', action: 'link', warehouseId: 'wh_main', stockSource: 'shopify' },
        { shopifyLocationId: '102', action: 'create', kind: 'WAREHOUSE' },
        { shopifyLocationId: '103', action: 'ignore' },
      ],
    });

    expect(view.status).toBe('DONE');
    expect(t.stockJobs()).toHaveLength(1);
  });

  it('refuses a Shopify location already linked to another location', async () => {
    const t = store();
    byId(t.warehouses, 'wh_kochi').shopifyLocationId = '101';

    await expect(
      t.decisions.apply(CHANNEL, ORG, {
        decisions: [{ shopifyLocationId: '101', action: 'link', warehouseId: 'wh_main', stockSource: 'shopify' }],
      }),
    ).rejects.toThrow(new BadRequestException('That Shopify location is already linked to Kochi store.'));
    expect(byId(t.warehouses, 'wh_main').shopifyLocationId).toBeNull();
  });

  it('refuses a location that already shares stock with another Shopify location', async () => {
    const t = store();
    byId(t.warehouses, 'wh_kochi').shopifyLocationId = '103';

    await expect(
      t.decisions.apply(CHANNEL, ORG, {
        decisions: [{ shopifyLocationId: '101', action: 'link', warehouseId: 'wh_kochi', stockSource: 'shopify' }],
      }),
    ).rejects.toThrow('Kochi store already shares stock with another Shopify location. Unlink it first.');
  });

  it('refuses one location for two Shopify locations in one go', async () => {
    const t = store();

    await expect(
      t.decisions.apply(CHANNEL, ORG, {
        decisions: [
          { shopifyLocationId: '101', action: 'link', warehouseId: 'wh_main', stockSource: 'shopify' },
          { shopifyLocationId: '102', action: 'link', warehouseId: 'wh_main', stockSource: 'shopify' },
        ],
      }),
    ).rejects.toThrow('Main warehouse can share stock with one Shopify location only.');
    expect(t.stockJobs()).toHaveLength(0);
  });

  it('asks whose counts to keep, and refuses a location it does not know', async () => {
    const t = store();

    await expect(
      t.decisions.apply(CHANNEL, ORG, { decisions: [{ shopifyLocationId: '101', action: 'link', warehouseId: 'wh_main' }] }),
    ).rejects.toThrow('Choose whose stock counts to keep.');
    await expect(
      t.decisions.apply(CHANNEL, ORG, { decisions: [{ shopifyLocationId: '999', action: 'ignore' }] }),
    ).rejects.toThrow("That Shopify location wasn't found. Refresh the list and try again.");
  });

  it('is refused while the workspace has no stock locations', async () => {
    const t = store();
    t.ledger.isWarehousingEnabled.mockResolvedValue(false);

    await expect(
      t.decisions.apply(CHANNEL, ORG, { decisions: [{ shopifyLocationId: '103', action: 'ignore' }] }),
    ).rejects.toThrow('Switch on stock locations before linking Shopify locations.');
  });
});

describe('the locations screen before Shopify has been read', () => {
  it('waits, with the locations it could share with', async () => {
    const t = build({ warehouses: [{ id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true }] });

    expect(await t.decisions.view(CHANNEL, ORG)).toEqual({
      status: 'PENDING',
      locations: [],
      warehouses: [{ id: 'wh_main', name: 'Main warehouse', kind: 'WAREHOUSE', isDefault: true, hasStock: false, shopifyLocationId: null }],
    });
  });

  it('has nothing to wait for in a workspace still on a single stock quantity', async () => {
    const t = build({ warehouses: [] });
    t.ledger.isWarehousingEnabled.mockResolvedValue(false);

    expect((await t.decisions.view(CHANNEL, ORG)).status).toBe('DONE');
  });
});

describe('recording the locations when a store connects', () => {
  it('reports them waiting, with nothing linked', async () => {
    const t = build({ warehouses: [{ id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true }] }, [
      node('101', 'MG Road', { isPrimary: true }),
    ]);

    expect(await t.decisions.onConnect(CHANNEL, ORG)).toEqual({ warehousing: true, recorded: true, pending: true, linked: false });
  });

  it('a reconnect with its locations decided is not waiting, and has stock to pull', async () => {
    const t = build(
      {
        warehouses: [{ id: 'wh_main', name: 'Main warehouse', code: 'WH1', isDefault: true, shopifyLocationId: '101' }],
        records: [{ shopifyLocationId: '101', name: 'MG Road', action: 'LINK', warehouseId: 'wh_main' }],
      },
      [node('101', 'MG Road', { isPrimary: true })],
    );

    expect(await t.decisions.onConnect(CHANNEL, ORG)).toEqual({ warehousing: true, recorded: true, pending: false, linked: true });
  });

  it('never fails the connect when Shopify cannot be read', async () => {
    const t = build({ warehouses: [] });
    t.graphql.request.mockRejectedValue(new Error('read_locations missing'));
    jest.spyOn((t.decisions as any).logger, 'warn').mockImplementation(() => undefined);

    expect(await t.decisions.onConnect(CHANNEL, ORG)).toEqual({ warehousing: true, recorded: false, pending: false, linked: false });
  });

  it('records nothing for a workspace still on a single stock quantity', async () => {
    const t = build({ warehouses: [] }, [node('101', 'MG Road', { isPrimary: true })]);
    t.ledger.isWarehousingEnabled.mockResolvedValue(false);

    expect(await t.decisions.onConnect(CHANNEL, ORG)).toEqual({ warehousing: false, recorded: false, pending: false, linked: false });
    expect(t.records).toHaveLength(0);
  });
});
