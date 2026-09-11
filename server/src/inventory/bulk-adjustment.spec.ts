import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StockBucket } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { WarehouseService } from './warehouse.service';
import { SkuGeneratorService } from './sku-generator.service';
import { OrganizationSettingsService } from '../organization-settings/organization-settings.service';

/**
 * The batch save behind the inventory table's inline editing.
 *
 * What matters here is that a screenful of edits lands on the location the
 * merchant is looking at, in one transaction, in a lock order that cannot
 * deadlock against a concurrent batch - not the SQL, which applyMovement owns.
 */
describe('InventoryService.createAdjustmentsBulk', () => {
  let service: InventoryService;
  let applyMovement: jest.Mock;
  let prisma: {
    warehouse: { findFirst: jest.Mock };
    productVariant: { findMany: jest.Mock };
    stockLevel: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const ORG = 'org_1';
  const USER = 'user_1';
  const WH = { id: 'wh_1', name: 'Main Store - Kochi', code: 'MSKOCH' };

  beforeEach(async () => {
    applyMovement = jest
      .fn()
      .mockImplementation(({ variantId }: { variantId: string }) =>
        Promise.resolve({ skipped: false, inventoryQuantity: 5, variantId }),
      );

    prisma = {
      warehouse: { findFirst: jest.fn().mockResolvedValue(WH) },
      productVariant: { findMany: jest.fn() },
      stockLevel: { findMany: jest.fn().mockResolvedValue([]) },
      // Run the callback inline; the tx client is never touched by these tests
      // because applyMovement is mocked.
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb({})),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: InventoryLedgerService,
          useValue: {
            applyMovement,
            isWarehousingEnabled: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: WarehouseService, useValue: { getDefault: jest.fn() } },
        { provide: SkuGeneratorService, useValue: {} },
        { provide: OrganizationSettingsService, useValue: {} },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get(InventoryService);
    // The Shopify push is fire-and-forget and not under test here.
    jest
      .spyOn(
        service as unknown as { enqueueAvailabilityPush: () => Promise<void> },
        'enqueueAvailabilityPush',
      )
      .mockResolvedValue(undefined);
  });

  const variants = (...ids: string[]) =>
    prisma.productVariant.findMany.mockResolvedValue(ids.map((id) => ({ id })));

  it('writes every line to the requested location, never a default', async () => {
    variants('v1', 'v2');

    await service.createAdjustmentsBulk(ORG, USER, {
      warehouseId: WH.id,
      items: [
        { variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 7 },
        { variantId: 'v2', bucket: StockBucket.AVAILABLE, setTo: 3 },
      ],
    });

    expect(applyMovement).toHaveBeenCalledTimes(2);
    for (const [args] of applyMovement.mock.calls) {
      expect(args.warehouseId).toBe(WH.id);
    }
  });

  it('locks variants in a stable order so two batches cannot deadlock', async () => {
    variants('v_b', 'v_a', 'v_c');

    await service.createAdjustmentsBulk(ORG, USER, {
      warehouseId: WH.id,
      items: [
        { variantId: 'v_b', bucket: StockBucket.AVAILABLE, delta: 1 },
        { variantId: 'v_a', bucket: StockBucket.AVAILABLE, delta: 1 },
        { variantId: 'v_c', bucket: StockBucket.AVAILABLE, delta: 1 },
      ],
    });

    expect(applyMovement.mock.calls.map(([a]) => a.variantId)).toEqual([
      'v_a',
      'v_b',
      'v_c',
    ]);
  });

  it('applies the whole batch inside one transaction', async () => {
    variants('v1', 'v2');

    await service.createAdjustmentsBulk(ORG, USER, {
      warehouseId: WH.id,
      items: [
        { variantId: 'v1', bucket: StockBucket.AVAILABLE, delta: 2 },
        { variantId: 'v2', bucket: StockBucket.AVAILABLE, delta: -1 },
      ],
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('turns setTo into a delta against the current quantity at that location', async () => {
    variants('v1');
    prisma.stockLevel.findMany.mockResolvedValue([
      { variantId: 'v1', available: 4, reserved: 0, qc: 0, damaged: 0 },
    ]);

    await service.createAdjustmentsBulk(ORG, USER, {
      warehouseId: WH.id,
      items: [{ variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 10 }],
    });

    const [args] = applyMovement.mock.calls[0];
    expect(args.quantity).toBe(6);
    expect(args.toBucket).toBe(StockBucket.AVAILABLE);
    expect(args.fromBucket).toBeNull();
  });

  it('drops a line typed back to its original value instead of rejecting it', async () => {
    variants('v1', 'v2');
    prisma.stockLevel.findMany.mockResolvedValue([
      { variantId: 'v1', available: 4, reserved: 0, qc: 0, damaged: 0 },
      { variantId: 'v2', available: 9, reserved: 0, qc: 0, damaged: 0 },
    ]);

    const out = await service.createAdjustmentsBulk(ORG, USER, {
      warehouseId: WH.id,
      items: [
        { variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 4 },
        { variantId: 'v2', bucket: StockBucket.AVAILABLE, setTo: 11 },
      ],
    });

    expect(applyMovement).toHaveBeenCalledTimes(1);
    expect(applyMovement.mock.calls[0][0].variantId).toBe('v2');
    expect(out.applied).toBe(1);
  });

  it('writes nothing when every line is a no-op', async () => {
    variants('v1');
    prisma.stockLevel.findMany.mockResolvedValue([
      { variantId: 'v1', available: 4, reserved: 0, qc: 0, damaged: 0 },
    ]);

    const out = await service.createAdjustmentsBulk(ORG, USER, {
      warehouseId: WH.id,
      items: [{ variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 4 }],
    });

    expect(out).toEqual({ ok: true, applied: 0, results: [] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a location belonging to another org', async () => {
    prisma.warehouse.findFirst.mockResolvedValue(null);

    await expect(
      service.createAdjustmentsBulk(ORG, USER, {
        warehouseId: 'wh_other_org',
        items: [{ variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 1 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('rejects the batch if any variant belongs to another org', async () => {
    variants('v1');

    await expect(
      service.createAdjustmentsBulk(ORG, USER, {
        warehouseId: WH.id,
        items: [
          { variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 1 },
          { variantId: 'v_elsewhere', bucket: StockBucket.AVAILABLE, setTo: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('rejects two lines for the same variant and bucket', async () => {
    variants('v1');

    await expect(
      service.createAdjustmentsBulk(ORG, USER, {
        warehouseId: WH.id,
        items: [
          { variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 5 },
          { variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 9 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a line carrying both delta and setTo', async () => {
    variants('v1');

    await expect(
      service.createAdjustmentsBulk(ORG, USER, {
        warehouseId: WH.id,
        items: [
          { variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 5, delta: 2 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
