import { StockLocationKind } from '@prisma/client';
import { OrganizationService } from './organization.service';
import { ensureDefaultLocation } from '../inventory/default-location';

/**
 * A new workspace starts on stock locations: a "Main warehouse" as its
 * default, and warehousing switched on — created in the same transaction as
 * the workspace, so one cannot exist without the other.
 */

function fakeTx(existing: { warehouse?: object | null; settings?: object | null } = {}) {
  return {
    organization: {
      create: jest.fn(async ({ data }: any) => ({ id: 'org_new', ...data, members: [] })),
      findUniqueOrThrow: jest.fn(async () => ({ id: 'org_new', name: 'Acme', type: 'ORGANIZATION', members: [] })),
    },
    warehouse: {
      findFirst: jest.fn().mockResolvedValue(existing.warehouse ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 'wh_main', ...data })),
    },
    organizationSettings: {
      findUnique: jest.fn().mockResolvedValue(existing.settings ?? null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function build() {
  const tx = fakeTx();
  const prisma = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    organization: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const billing = { applyPendingSubscriptionToOrg: jest.fn().mockResolvedValue(undefined) };
  const service = new OrganizationService(
    prisma as any,
    billing as any,
    { deleteSession: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
  );
  jest.spyOn(service as any, 'formatOrg').mockImplementation((org: any) => org);
  return { service, tx };
}

const expectMainWarehouse = (tx: ReturnType<typeof fakeTx>) => {
  expect(tx.warehouse.create).toHaveBeenCalledWith({
    data: {
      organizationId: 'org_new',
      name: 'Main warehouse',
      code: 'WH1',
      kind: StockLocationKind.WAREHOUSE,
      isDefault: true,
    },
    select: { id: true },
  });
  const settings = tx.organizationSettings.upsert.mock.calls[0][0];
  expect(settings.where).toEqual({ organizationId: 'org_new' });
  expect(settings.create.inventorySettings.warehousingEnabled).toBe(true);
  expect(settings.update.inventorySettings.warehousingEnabled).toBe(true);
};

describe('sign-up creates the Main warehouse with warehousing on', () => {
  it('for a team workspace', async () => {
    const { service, tx } = build();
    await service.create('u_1', { name: 'Acme', billingPlan: 'BASIC' } as any);
    expectMainWarehouse(tx);
  });

  it('for a personal workspace', async () => {
    const { service, tx } = build();
    await service.createPersonal('u_1', 'Asha', { billingPlan: 'BASIC' } as any);
    expectMainWarehouse(tx);
  });
});

describe('ensureDefaultLocation', () => {
  it('keeps an existing default location and the other inventory settings', async () => {
    const tx = fakeTx({
      warehouse: { id: 'wh_old' },
      settings: { inventorySettings: { skuPrefix: 'ACM', qcOnReceiving: true } },
    });

    expect(await ensureDefaultLocation(tx as any, 'org_new')).toEqual({ id: 'wh_old' });

    expect(tx.warehouse.create).not.toHaveBeenCalled();
    const written = tx.organizationSettings.upsert.mock.calls[0][0].update.inventorySettings;
    expect(written).toEqual(expect.objectContaining({ warehousingEnabled: true, skuPrefix: 'ACM', qcOnReceiving: true }));
  });
});
