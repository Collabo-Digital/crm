import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PosCatalogService, POS_OUT_OF_SCOPE } from './pos-catalog.service';
import { PosController } from './pos.controller';
import { PosSaleService } from './pos-sale.service';
import { PosReportsService } from './reports/pos-reports.service';

/**
 * A Manager or Agent limited to some stores (auth/location-scope.util) sees
 * and bills at those stores only: the till lists them alone, opens and sells
 * at them alone, and store reports cover them alone.
 */

const ORG = 'org_1';
const STORES = [
  { id: 'st_mg', name: 'MG Road', code: 'MG', kind: 'STORE', isDefault: true, isActive: true, address: { stateCode: '29' }, gstin: null },
  { id: 'st_ko', name: 'Kochi', code: 'KO', kind: 'STORE', isDefault: false, isActive: true, address: { stateCode: '32' }, gstin: null },
  { id: 'st_pu', name: 'Pune', code: 'PU', kind: 'STORE', isDefault: false, isActive: true, address: { stateCode: '27' }, gstin: null },
];

function catalog() {
  // The where clauses the service sends, as Postgres would answer them.
  const matching = (where: any) =>
    STORES.filter(
      (w) =>
        (where.kind === undefined || w.kind === where.kind) &&
        (where.isActive === undefined || w.isActive === where.isActive) &&
        (where.id === undefined || (typeof where.id === 'string' ? w.id === where.id : where.id.in.includes(w.id))),
    ).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  const prisma: any = {
    organizationSettings: { findUnique: jest.fn().mockResolvedValue({ posSettings: null }) },
    organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme', gstEnabled: false, currency: 'INR' }) },
    warehouse: {
      findMany: jest.fn(async ({ where }: any) => matching(where)),
      findFirst: jest.fn(async ({ where }: any) => matching(where)[0] ?? null),
    },
    productVariant: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    stockLevel: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  const service = new PosCatalogService(
    prisma,
    {
      getStoreProfileSettings: jest.fn().mockResolvedValue({ storeName: '' }),
      getProductSettings: jest.fn().mockResolvedValue({}),
      getTaxSettings: jest.fn().mockResolvedValue({ composition: false }),
    } as any,
    { isWarehousingEnabled: jest.fn().mockResolvedValue(true) } as any,
    { getRate: jest.fn() } as any,
    { list: jest.fn().mockResolvedValue([]) } as any,
  );
  return { service, prisma };
}

describe('the till for a store-limited member', () => {
  it('lists only their stores, and opens their first one in place of a store they no longer work at', async () => {
    const { service, prisma } = catalog();
    const setup = await service.setup(ORG, 'st_mg', ['st_ko', 'st_pu']);
    expect(setup.stores.map((s) => s.id)).toEqual(['st_ko', 'st_pu']);
    expect(prisma.warehouse.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'st_ko' }) }));
  });

  it('lists every store for everyone else', async () => {
    const { service } = catalog();
    expect((await service.setup(ORG)).stores.map((s) => s.id)).toEqual(['st_mg', 'st_ko', 'st_pu']);
  });

  it('refuses a store outside their list with a 403, before reading it', async () => {
    const { service, prisma } = catalog();
    await expect(service.resolveStore(ORG, 'st_mg', ['st_ko'])).rejects.toThrow(new ForbiddenException(POS_OUT_OF_SCOPE));
    await expect(service.products(ORG, { storeId: 'st_mg' }, ['st_ko'])).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.scan(ORG, '8901', 'st_mg', ['st_ko'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.warehouse.findFirst).not.toHaveBeenCalled();
  });

  it('bills at their own store, and at their first store when none is named', async () => {
    const { service } = catalog();
    expect((await service.resolveStore(ORG, 'st_ko', ['st_ko', 'st_pu'])).id).toBe('st_ko');
    expect((await service.resolveStore(ORG, undefined, ['st_pu', 'st_ko'])).id).toBe('st_ko');
  });

  it('refuses to bill when none of their locations is a store', async () => {
    const { service } = catalog();
    await expect(service.resolveStore(ORG, undefined, ['wh_back'])).rejects.toThrow("You don't work at any store");
  });
});

describe('opening the till with a PIN', () => {
  function controller(role: UserRole, scope: string[]) {
    const { service: catalogService } = catalog();
    const staff = { unlock: jest.fn().mockResolvedValue({ staffToken: 't' }) };
    const prisma = { organizationMember: { findUnique: jest.fn().mockResolvedValue({ locationScope: scope }) } };
    const pos = new PosController(catalogService, staff as never, {} as never, {} as never, {} as never, prisma as never);
    return { pos, staff, user: { sub: 'u1', email: 'a@b.in', orgId: ORG, role } };
  }

  it('is refused at a store the member does not work at', async () => {
    const { pos, staff, user } = controller(UserRole.AGENT, ['st_ko']);
    await expect(pos.unlock(user, { pin: '1234', storeId: 'st_mg' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(staff.unlock).not.toHaveBeenCalled();
  });

  it('opens at their own store, which goes on the counter log', async () => {
    const { pos, staff, user } = controller(UserRole.MANAGER, ['st_ko']);
    await pos.unlock(user, { pin: '1234', storeId: 'st_ko' });
    expect(staff.unlock).toHaveBeenCalledWith(ORG, 'u1', '1234', 'st_ko');
  });

  it('checks nothing for an owner, wherever the till is', async () => {
    const { pos, staff, user } = controller(UserRole.OWNER, ['st_ko']);
    await pos.unlock(user, { pin: '1234', storeId: 'st_mg' });
    expect(staff.unlock).toHaveBeenCalledWith(ORG, 'u1', '1234', 'st_mg');
  });
});

describe('selling and collecting outside the member’s stores', () => {
  function sales(dispatchWarehouseId: string | null) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'o1', dispatchWarehouseId, totalPrice: 100, metadata: null, financialStatus: 'PENDING', cancelledAt: null, payments: [] }) },
      orderPayment: { create: jest.fn() },
    };
    const prisma = {
      order: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const catalogService = {
      settings: jest.fn().mockResolvedValue({ requireStaffPin: false, customerAtCheckout: 'optional' }),
      resolveStore: jest.fn().mockRejectedValue(new ForbiddenException(POS_OUT_OF_SCOPE)),
    };
    const orders = { createOfflineOrder: jest.fn() };
    const service = new PosSaleService(
      prisma as never, orders as never, catalogService as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    return { service, orders, tx, catalogService };
  }

  it('makes no sale at a store outside the list', async () => {
    const { service, orders, catalogService } = sales(null);
    await expect(
      service.createSale(ORG, 'u1', { clientSaleId: '6f1c2a8e-3b7d-4c55-9a10-2b1f0e9d7c41', storeId: 'st_mg', lines: [{ variantId: 'v', quantity: 1 }], payments: [] }, ['st_ko']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(catalogService.resolveStore).toHaveBeenCalledWith(ORG, 'st_mg', ['st_ko']);
    expect(orders.createOfflineOrder).not.toHaveBeenCalled();
  });

  it("takes no payment on another store's bill", async () => {
    const { service, tx } = sales('st_mg');
    await expect(service.collectPayment(ORG, 'u1', 'o1', { method: 'CASH', amount: 50 }, ['st_ko'])).rejects.toThrow(
      new ForbiddenException(POS_OUT_OF_SCOPE),
    );
    expect(tx.orderPayment.create).not.toHaveBeenCalled();
  });
});

describe('store reports for a store-limited manager', () => {
  function reports() {
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata', currency: 'INR' }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      warehouse: { findMany: jest.fn().mockResolvedValue([]) },
      posStaff: { findMany: jest.fn().mockResolvedValue([]) },
      posActivity: { findMany: jest.fn().mockResolvedValue([]) },
      organizationMember: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { service: new PosReportsService(prisma as never), prisma };
  }
  /** Every value bound into the summary's three queries. */
  const bound = (prisma: ReturnType<typeof reports>['prisma']) =>
    (prisma.$queryRaw.mock.calls as unknown[][]).flatMap((call) => call.slice(1).flatMap((v: any) => v?.values ?? [v]));

  it('adds up their stores only', async () => {
    const { service, prisma } = reports();
    await service.getSummary(ORG, { from: '2026-11-01', to: '2026-11-02' }, ['st_ko', 'st_pu']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(bound(prisma)).toContainEqual(['st_ko', 'st_pu']);
  });

  it('shows nothing for a store outside their list', async () => {
    const { service, prisma } = reports();
    await service.getSummary(ORG, { storeId: 'st_mg' }, ['st_ko']);
    expect(bound(prisma)).toContainEqual([]);
    expect(bound(prisma)).not.toContain('st_mg');
  });

  it('logs what happened at their stores: bills there, and tills opened there', async () => {
    const { service, prisma } = reports();
    await service.getActivity(ORG, { limit: 50 }, ['st_ko']);
    expect(prisma.posActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          OR: [{ order: { dispatchWarehouseId: { in: ['st_ko'] } } }, { details: { path: ['storeId'], equals: 'st_ko' } }],
        },
      }),
    );
  });

  it('leaves the log whole for everyone else', async () => {
    const { service, prisma } = reports();
    await service.getActivity(ORG, { limit: 50 });
    expect(prisma.posActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG } }));
  });
});
