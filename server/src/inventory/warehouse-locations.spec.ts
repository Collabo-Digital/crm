import { BadRequestException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { LocationLinkService } from './location-links.service';

/**
 * Creating and editing a stock location: Store or Warehouse, its state, and
 * "does this location have its own GST number?" — answered only while GST is
 * on. Run against a small in-memory stand-in so the assertions read as the
 * resulting state.
 */

const ORG = 'org_1';
type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'channel') return true;
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if ('not' in want) return row[key] !== want.not;
      return false;
    }
    return want === undefined || row[key] === want;
  });
}
const defined = (data: Row) => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

function build(opts: { gstEnabled?: boolean; bins?: number } = {}) {
  const warehouses: Row[] = [
    { id: 'wh_main', organizationId: ORG, name: 'Main warehouse', code: 'WH1', kind: 'WAREHOUSE', isDefault: true, isActive: true, address: null, gstinId: null, shopifyLocationId: null, apobDeclared: false, createdAt: new Date(1) },
  ];
  const gstins: Row[] = [
    { id: 'g_ka', organizationId: ORG, gstin: '29AAACA1234A1Z5', stateCode: '29', stateName: 'Karnataka', isDefault: true, isActive: true, createdAt: new Date(1) },
  ];
  const records: Row[] = [
    { id: 'rec_101', organizationId: ORG, channelId: 'ch_1', shopifyLocationId: '101', name: 'Kochi (Shopify)', action: null, warehouseId: null, decidedAt: null },
  ];
  let seq = 0;
  const db: any = {
    warehouse: {
      count: jest.fn(async () => warehouses.length),
      findFirst: jest.fn(async ({ where }: any) => warehouses.find((w) => matches(w, where)) ?? null),
      findMany: jest.fn(async () => warehouses.map((w) => ({ ...w, _count: { locations: 0, stockLevels: 0 } }))),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `wh_${++seq}`, shopifyLocationId: null, isActive: true, createdAt: new Date(), ...defined(data) };
        warehouses.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(warehouses.find((w) => w.id === where.id)!, defined(data))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        warehouses.filter((w) => matches(w, where)).forEach((w) => Object.assign(w, defined(data)));
      }),
    },
    warehouseLocation: { count: jest.fn(async () => opts.bins ?? 0) },
    stockLevel: { groupBy: jest.fn(async () => []) },
    organization: { findUnique: jest.fn(async () => ({ gstEnabled: opts.gstEnabled ?? true, name: 'Acme Pvt Ltd' })) },
    organizationGstin: {
      findFirst: jest.fn(async ({ where }: any) => gstins.find((g) => matches(g, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => gstins.filter((g) => matches(g, where))),
      count: jest.fn(async ({ where }: any) => gstins.filter((g) => matches(g, where)).length),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `g_${data.stateCode}`, isActive: true, createdAt: new Date(), ...data };
        gstins.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(gstins.find((g) => g.id === where.id)!, data)),
    },
    shopifyLocationLink: {
      findMany: jest.fn(async ({ where }: any) => records.filter((r) => matches(r, where))),
      findFirst: jest.fn(async ({ where }: any) => records.find((r) => matches(r, where)) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(records.find((r) => r.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        records.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, data));
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(db)),
  };
  const pushQueue = { getJob: jest.fn().mockResolvedValue(undefined), add: jest.fn().mockResolvedValue(undefined) };
  const service = new WarehouseService(db, new LocationLinkService(pushQueue as any));
  return { service, warehouses, gstins, records, pushQueue };
}

const kochi = { address1: '1 MG Road', city: 'Kochi', zip: '682001', stateCode: '32' };

describe('WarehouseService — creating a location', () => {
  it('a store with its own GSTIN: added to the GST registrations and linked, its state named', async () => {
    const { service, gstins } = build();

    const created = await service.create(ORG, {
      name: 'Kochi store',
      code: 'KO',
      kind: 'STORE',
      address: kochi,
      gst: { mode: 'new', gstin: '32aaaca1234a1z1', legalName: 'Acme Kerala LLP' },
    });

    const added = gstins.find((g) => g.gstin === '32AAACA1234A1Z1')!;
    expect(added).toEqual(expect.objectContaining({ stateCode: '32', stateName: 'Kerala', legalName: 'Acme Kerala LLP', isDefault: false }));
    expect(created).toEqual(expect.objectContaining({ kind: 'STORE', gstinId: added.id, gstWarning: null, shopifyLocation: null }));
    expect(created.address).toEqual({ ...kochi, province: 'Kerala' });
  });

  it('refuses a GSTIN from another state, in a sentence', async () => {
    const { service, gstins } = build();

    await expect(
      service.create(ORG, { name: 'Kochi store', code: 'KO', kind: 'STORE', address: kochi, gst: { mode: 'new', gstin: '29AAACA9999A1Z5' } }),
    ).rejects.toThrow(new BadRequestException('This GSTIN is for Karnataka but the location is in Kerala.'));
    expect(gstins).toHaveLength(1);
    await expect(
      service.create(ORG, { name: 'Kochi store', code: 'KO', kind: 'STORE', address: kochi, gst: { mode: 'existing', gstinId: 'g_ka' } }),
    ).rejects.toThrow('This GSTIN is for Karnataka but the location is in Kerala.');
  });

  it('a GSTIN typed in again is the registration already there', async () => {
    const { service, gstins } = build();

    const created = await service.create(ORG, {
      name: 'Brigade Road',
      code: 'BR',
      kind: 'STORE',
      address: { ...kochi, city: 'Bengaluru', stateCode: '29' },
      gst: { mode: 'new', gstin: '29AAACA1234A1Z5' },
    });

    expect(gstins).toHaveLength(1);
    expect(created.gstinId).toBe('g_ka');
  });

  it('no GSTIN of its own: the workspace’s GSTIN for its state', async () => {
    const { service } = build();

    const created = await service.create(ORG, {
      name: 'Brigade Road',
      code: 'BR',
      kind: 'STORE',
      address: { ...kochi, stateCode: '29' },
      gst: { mode: 'none' },
    });

    expect(created).toEqual(expect.objectContaining({ gstinId: 'g_ka', gstWarning: null }));
  });

  it('no GSTIN for its state: allowed, saying GST invoices cannot be issued from there yet', async () => {
    const { service } = build();

    const created = await service.create(ORG, {
      name: 'Chennai store',
      code: 'CH',
      kind: 'STORE',
      address: { ...kochi, stateCode: '33' },
      gst: { mode: 'none' },
    });

    expect(created.gstinId).toBeNull();
    expect(created.gstWarning).toBe('Add a GSTIN for Tamil Nadu to issue GST invoices for sales from here.');
  });

  it('asks for the state while GST is on, and not while it is off', async () => {
    await expect(
      build().service.create(ORG, { name: 'Somewhere', code: 'SW', kind: 'WAREHOUSE', address: { city: 'Kochi' } }),
    ).rejects.toThrow('Choose the state this location is in.');

    const off = build({ gstEnabled: false });
    const created = await off.service.create(ORG, { name: 'Somewhere', code: 'SW', kind: 'WAREHOUSE', gst: { mode: 'new', gstin: '29AAACA9999A1Z5' } });
    expect(created).toEqual(expect.objectContaining({ kind: 'WAREHOUSE', gstinId: null, gstWarning: null }));
    expect(off.gstins).toHaveLength(1);
  });

  it('can share stock with a Shopify location from the start, keeping its own counts', async () => {
    const { service, records, pushQueue } = build();

    const created = await service.create(ORG, {
      name: 'Kochi store',
      code: 'KO',
      kind: 'STORE',
      address: kochi,
      shopifyLocationId: '101',
      stockSource: 'collabo',
    });

    expect(created.shopifyLocation).toEqual({ id: '101', name: 'Kochi (Shopify)' });
    expect(records[0]).toEqual(expect.objectContaining({ action: 'LINK', warehouseId: created.id }));
    expect(pushQueue.add).toHaveBeenCalledWith(
      'sync-locations',
      expect.objectContaining({ pushWarehouseIds: [created.id] }),
      expect.anything(),
    );
  });
});

describe('WarehouseService — editing a location', () => {
  it('refuses a move to another state that the linked GSTIN does not cover, unless GST is answered again', async () => {
    const { service } = build();
    await service.update(ORG, 'wh_main', { address: { ...kochi, stateCode: '29' }, gst: { mode: 'none' } });

    await expect(service.update(ORG, 'wh_main', { address: kochi })).rejects.toThrow(
      'This GSTIN is for Karnataka but the location is in Kerala.',
    );
    const moved = await service.update(ORG, 'wh_main', { address: kochi, gst: { mode: 'none' } });
    expect(moved).toEqual(expect.objectContaining({ gstinId: null, gstWarning: 'Add a GSTIN for Kerala to issue GST invoices for sales from here.' }));
  });

  it('changes its kind, and links and unlinks a Shopify location', async () => {
    const { service, records, pushQueue } = build();

    const linked = await service.update(ORG, 'wh_main', { kind: 'STORE', shopifyLocationId: '101', stockSource: 'shopify' });
    expect(linked).toEqual(expect.objectContaining({ kind: 'STORE', shopifyLocationId: '101' }));
    expect(pushQueue.add).toHaveBeenCalledWith('sync-locations', expect.objectContaining({ pushWarehouseIds: [] }), expect.anything());

    const unlinked = await service.update(ORG, 'wh_main', { shopifyLocationId: null });
    expect(unlinked.shopifyLocation).toBeNull();
    // The Shopify location waits for a decision again.
    expect(records[0]).toEqual(expect.objectContaining({ action: null, warehouseId: null }));
  });

  it('keeps the code once racks and bins carry it', async () => {
    await expect(build({ bins: 12 }).service.update(ORG, 'wh_main', { code: 'MAIN' })).rejects.toThrow(
      "The code can't change once racks and bins use it.",
    );
    expect((await build().service.update(ORG, 'wh_main', { code: 'MAIN' })).code).toBe('MAIN');
  });
});
