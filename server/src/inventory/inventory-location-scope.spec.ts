import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { StockBucket, UserRole } from '@prisma/client';
import { STOCK_OUT_OF_SCOPE } from '../auth/location-scope.util';
import { ChannelController } from '../channel/channel.controller';
import { ProductController } from '../product/product.controller';
import { InventoryLedgerService } from './inventory-ledger.service';
import { InventoryService } from './inventory.service';
import { WarehouseController } from './warehouse.controller';

/**
 * A Manager or Agent limited to some locations (auth/location-scope.util)
 * reads stock at those locations only, and changes it nowhere else.
 */

const ORG = 'org_1';
const SCOPE = ['st_ko', 'wh_back'];

function inventory() {
  const prisma = {
    stockLevel: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      aggregate: jest.fn(() => Promise.resolve({ _sum: {} })),
    },
    stockReservation: { findMany: jest.fn(() => Promise.resolve([])) },
    inventoryEvent: { findMany: jest.fn(() => Promise.resolve([])), count: jest.fn(() => Promise.resolve(0)) },
    productVariant: {
      findFirst: jest.fn(() => Promise.resolve({ id: 'v1' })),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    organization: { findUnique: jest.fn(() => Promise.resolve({ lowStockThreshold: 10 })) },
    $queryRaw: jest.fn(() => Promise.resolve([{ value: 0 }])),
  };
  const ledger = { isWarehousingEnabled: jest.fn(() => Promise.resolve(true)) };
  const service = new InventoryService(prisma as never, {} as never, ledger as never, {} as never, {} as never, {} as never);
  return { service, prisma, ledger };
}

describe('stock reads for a store-limited member', () => {
  it('lists stock at their locations only', async () => {
    const { service, prisma } = inventory();
    await service.listStock(ORG, {}, SCOPE);
    expect(prisma.stockLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG, warehouseId: { in: SCOPE } }) }),
    );
  });

  it('lists nothing for a location outside their list, and the one asked for inside it', async () => {
    const { service, prisma } = inventory();
    await service.listStock(ORG, { warehouseId: 'st_mg' }, SCOPE);
    await service.listStock(ORG, { warehouseId: 'st_ko' }, SCOPE);
    const wheres = (prisma.stockLevel.findMany.mock.calls as unknown as Array<[{ where: { warehouseId: unknown } }]>).map(
      ([args]) => args.where.warehouseId,
    );
    expect(wheres).toEqual([{ in: [] }, 'st_ko']);
  });

  it('leaves the list whole for everyone else', async () => {
    const { service, prisma } = inventory();
    await service.listStock(ORG, {});
    const [[args]] = prisma.stockLevel.findMany.mock.calls as unknown as Array<[{ where: object }]>;
    expect(args.where).not.toHaveProperty('warehouseId');
  });

  it('adds up the stat tiles over their locations only', async () => {
    const { service, prisma } = inventory();
    await service.getStockStats(ORG, undefined, SCOPE);
    expect(prisma.stockLevel.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ warehouseId: { in: SCOPE } }) }),
    );
    const values = (prisma.$queryRaw.mock.calls as unknown as unknown[][])[0].slice(1).flatMap((v: any) => v?.values ?? [v]);
    expect(values).toContainEqual(SCOPE);
  });

  it("shows a product's stock, holds and history at their locations only", async () => {
    const { service, prisma } = inventory();
    await service.getVariantStock(ORG, 'v1', SCOPE);
    expect(prisma.stockLevel.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { variantId: 'v1', warehouseId: { in: SCOPE } } }));
    expect(prisma.stockReservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { variantId: 'v1', status: 'ACTIVE', warehouseId: { in: SCOPE } } }),
    );
    expect(prisma.inventoryEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, variantId: 'v1', warehouseId: { in: SCOPE } } }),
    );
  });

  it('keeps the stock history to their locations', async () => {
    const { service, prisma } = inventory();
    await service.listLedger(ORG, { warehouseId: 'st_mg' }, SCOPE);
    await service.listLedger(ORG, {}, SCOPE);
    const wheres = (prisma.inventoryEvent.findMany.mock.calls as unknown as Array<[{ where: { warehouseId: unknown } }]>).map(
      ([args]) => args.where.warehouseId,
    );
    expect(wheres).toEqual([{ in: [] }, { in: SCOPE }]);
  });

  it('shows a scanned product’s stock at their locations only', async () => {
    const { service, prisma } = inventory();
    await service.lookup(ORG, '8901', SCOPE);
    expect(prisma.productVariant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ stockLevels: expect.objectContaining({ where: { warehouseId: { in: SCOPE } } }) }),
      }),
    );
  });
});

describe('stock changes outside the member’s locations', () => {
  it('refuses an adjustment there with a 403, before anything is read', async () => {
    const { service, ledger } = inventory();
    const dto = { variantId: 'v1', warehouseId: 'st_mg', bucket: StockBucket.AVAILABLE, delta: 2 };
    await expect(service.createAdjustment(ORG, 'u1', dto, SCOPE)).rejects.toThrow(new ForbiddenException(STOCK_OUT_OF_SCOPE));
    await expect(
      service.createAdjustmentsBulk(ORG, 'u1', { warehouseId: 'st_mg', items: [{ variantId: 'v1', bucket: StockBucket.AVAILABLE, delta: 1 }] }, SCOPE),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ledger.isWarehousingEnabled).not.toHaveBeenCalled();
  });

  it('lets an adjustment at their own location through', async () => {
    const { service, ledger } = inventory();
    ledger.isWarehousingEnabled.mockResolvedValue(false);
    const dto = { variantId: 'v1', warehouseId: 'st_ko', bucket: StockBucket.AVAILABLE, delta: 2 };
    // Past the scope check, it stops at the next rule: warehousing off.
    await expect(service.createAdjustment(ORG, 'u1', dto, SCOPE)).rejects.toThrow('Warehousing is not enabled');
  });
});

describe('locations and their set-up for a store-limited member', () => {
  function controller(role: UserRole, scope: string[]) {
    const warehouses = {
      findAll: jest.fn(() => Promise.resolve([])),
      create: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
      listLocations: jest.fn(() => Promise.resolve([])),
      bulkCreateLocations: jest.fn(() => Promise.resolve({})),
    };
    const prisma = { organizationMember: { findUnique: jest.fn(() => Promise.resolve({ locationScope: scope })) } };
    const user = { sub: 'u1', email: 'm@shop.in', orgId: ORG, role };
    return { c: new WarehouseController(warehouses as never, prisma as never), warehouses, user };
  }

  it('lists only their locations', async () => {
    const { c, warehouses, user } = controller(UserRole.MANAGER, SCOPE);
    await c.findAll(ORG, user);
    expect(warehouses.findAll).toHaveBeenCalledWith(ORG, SCOPE);
  });

  it('lists every location for an admin', async () => {
    const { c, warehouses, user } = controller(UserRole.ADMIN, SCOPE);
    await c.findAll(ORG, user);
    expect(warehouses.findAll).toHaveBeenCalledWith(ORG, null);
  });

  it('refuses changes to a location outside their list, and its racks and bins', async () => {
    const { c, warehouses, user } = controller(UserRole.MANAGER, SCOPE);
    await expect(c.update(ORG, user, 'st_mg', { isActive: false })).rejects.toThrow(new ForbiddenException(STOCK_OUT_OF_SCOPE));
    await expect(c.bulkCreateLocations(ORG, user, 'st_mg', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.listLocations(ORG, user, 'st_mg')).rejects.toBeInstanceOf(NotFoundException);
    expect(warehouses.update).not.toHaveBeenCalled();
    expect(warehouses.bulkCreateLocations).not.toHaveBeenCalled();
    expect(warehouses.listLocations).not.toHaveBeenCalled();
  });

  it('lets them set up their own location', async () => {
    const { c, warehouses, user } = controller(UserRole.MANAGER, SCOPE);
    await c.update(ORG, user, 'st_ko', { name: 'Kochi MG' });
    expect(warehouses.update).toHaveBeenCalledWith(ORG, 'st_ko', { name: 'Kochi MG' });
  });

  it('refuses a new location, which would be outside their own list', async () => {
    const { c, warehouses, user } = controller(UserRole.MANAGER, SCOPE);
    await expect(c.create(ORG, user, { name: 'Pune', code: 'PU' } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(warehouses.create).not.toHaveBeenCalled();
  });
});

describe('"Edit locations" for a store-limited member', () => {
  const row = (warehouseId: string, available = 0) => ({
    id: `row_${warehouseId}`,
    warehouseId,
    available,
    reserved: 0,
    qc: 0,
    damaged: 0,
    warehouse: { name: warehouseId, isActive: true, shopifyLocationId: null },
  });

  function ledger(rows: ReturnType<typeof row>[], requested: string[]) {
    const db = {
      $queryRaw: jest.fn(() => Promise.resolve([])),
      warehouse: { findMany: jest.fn(() => Promise.resolve(requested.map((id) => ({ id, shopifyLocationId: null })))) },
      stockLevel: {
        findMany: jest.fn(() => Promise.resolve(rows)),
        createMany: jest.fn(() => Promise.resolve({ count: 0 })),
        deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) => Promise.resolve({ count: where.id.in.length })),
      },
    };
    return { service: new InventoryLedgerService({} as never, {} as never), db };
  }

  it('leaves the locations they do not work at as they are', async () => {
    // Stocked at Kochi (theirs, empty) and MG Road (not theirs); they untick Kochi.
    const { service, db } = ledger([row('st_ko'), row('st_mg')], ['wh_back']);
    const change = await service.setVariantLocations(db as never, ORG, 'v1', ['wh_back'], SCOPE);
    expect(change.removed).toEqual([{ warehouseId: 'st_ko', shopifyLocationId: null }]);
    expect(change.added).toEqual([{ warehouseId: 'wh_back', shopifyLocationId: null }]);
    expect(db.stockLevel.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['row_st_ko'] } }) }));
  });

  it('refuses stocking it at a location they do not work at', async () => {
    const { service, db } = ledger([row('st_ko')], ['st_ko', 'st_mg']);
    await expect(service.setVariantLocations(db as never, ORG, 'v1', ['st_ko', 'st_mg'], SCOPE)).rejects.toThrow(
      new ForbiddenException(STOCK_OUT_OF_SCOPE),
    );
    expect(db.stockLevel.createMany).not.toHaveBeenCalled();
  });

  it('removes any location for everyone else', async () => {
    const { service, db } = ledger([row('st_ko'), row('st_mg')], ['wh_back']);
    const change = await service.setVariantLocations(db as never, ORG, 'v1', ['wh_back']);
    expect(change.removed.map((r) => r.warehouseId)).toEqual(['st_ko', 'st_mg']);
  });
});

describe('linking Shopify locations', () => {
  function controller(scope: string[]) {
    const prisma = { organizationMember: { findUnique: jest.fn(() => Promise.resolve({ locationScope: scope })) } };
    const decisions = { apply: jest.fn(() => Promise.resolve({})) };
    const deps = Array.from({ length: 13 }, () => ({}) as never);
    deps[0] = prisma as never;
    deps[11] = decisions as never;
    return { c: new (ChannelController as any)(...deps) as ChannelController, decisions };
  }
  const manager = { sub: 'u1', email: 'm@shop.in', orgId: ORG, role: UserRole.MANAGER };

  it('is refused to a store-limited manager: it makes and links locations across the workspace', async () => {
    const { c, decisions } = controller(SCOPE);
    await expect(c.decideShopifyLocations('ch1', manager, { decisions: [] } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(decisions.apply).not.toHaveBeenCalled();
  });

  it('is open to a manager who works everywhere', async () => {
    const { c, decisions } = controller([]);
    await c.decideShopifyLocations('ch1', manager, { decisions: [] } as never);
    expect(decisions.apply).toHaveBeenCalledWith('ch1', ORG, { decisions: [] });
  });
});

describe("the product editor's quantities", () => {
  function controller(scope: string[]) {
    const products = {
      create: jest.fn(() => Promise.resolve({})),
      updateVariant: jest.fn(() => Promise.resolve({})),
      bulkUpdateVariants: jest.fn(() => Promise.resolve({})),
    };
    const prisma = { organizationMember: { findUnique: jest.fn(() => Promise.resolve({ locationScope: scope })) } };
    return { c: new ProductController(products as never, prisma as never), products, prisma };
  }
  const agent = { sub: 'u1', email: 'a@shop.in', orgId: ORG, role: UserRole.AGENT };

  it('refuses opening stock or a quantity at a location the member does not work at', async () => {
    const { c, products } = controller(SCOPE);
    await expect(
      c.create(agent, { title: 'Kurta', variants: [{ stock: [{ warehouseId: 'st_ko', quantity: 2 }, { warehouseId: 'st_mg', quantity: 1 }] }] } as never),
    ).rejects.toThrow(new ForbiddenException(STOCK_OUT_OF_SCOPE));
    await expect(c.updateVariant('v1', agent, { inventoryQuantity: 4, warehouseId: 'st_mg' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.bulkUpdateVariants('p1', agent, { updates: [{ variantId: 'v1', inventoryQuantity: 1, warehouseId: 'st_mg' }] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(products.create).not.toHaveBeenCalled();
    expect(products.updateVariant).not.toHaveBeenCalled();
    expect(products.bulkUpdateVariants).not.toHaveBeenCalled();
  });

  it('lets quantities at their own locations through, and reads no scope for a body without any', async () => {
    const { c, products, prisma } = controller(SCOPE);
    await c.updateVariant('v1', agent, { inventoryQuantity: 4, warehouseId: 'st_ko' });
    expect(products.updateVariant).toHaveBeenCalled();
    prisma.organizationMember.findUnique.mockClear();
    await c.updateVariant('v1', agent, { price: 999 });
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });
});
