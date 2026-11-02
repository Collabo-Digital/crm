import { InventoryLedgerService } from './inventory-ledger.service';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { StockBucket } from '@prisma/client';

/**
 * Editing a quantity from the product screen must move a warehouse bucket.
 *
 * `auditedVariantUpdate` used to write `inventoryQuantity` straight onto the
 * variant. For a warehousing org that column is a derived cache over
 * stock_levels, so the units entered no bucket, were attributed to no
 * location, never reached Shopify, and were erased by the next applyMovement,
 * which recomputes the cache. Production on 2026-09-04: SJ00376 was edited +1
 * then +2 from the product screen and all three units vanished when a Kochi
 * adjustment landed 13 minutes later.
 */

const ORG = 'org_1';
const VARIANT = 'var_1';
const WAREHOUSE = 'wh_kochi';
const WAREHOUSES = [
  { id: WAREHOUSE, organizationId: ORG, isActive: true },
  { id: 'wh_closed', organizationId: ORG, isActive: false },
  { id: 'wh_other_org', organizationId: 'org_2', isActive: true },
];
type WarehouseWhere = { id: string; organizationId: string; isActive?: boolean };

function build({ warehousing, currentAvailable = 2 }) {
  const db: any = {
    warehouse: {
      findFirst: jest.fn(({ where }: { where: WarehouseWhere }) =>
        Promise.resolve(
          WAREHOUSES.find(
            (w) =>
              w.id === where.id &&
              w.organizationId === where.organizationId &&
              (where.isActive === undefined || w.isActive === where.isActive),
          ) ?? null,
        ),
      ),
    },
    productVariant: {
      findUnique: jest.fn().mockResolvedValue({ inventoryQuantity: 3, sku: 'SJ00376' }),
      update: jest.fn().mockResolvedValue({ inventoryQuantity: 5, sku: 'SJ00376' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ inventoryQuantity: 6, sku: 'SJ00376' }),
    },
    stockLevel: { findFirst: jest.fn().mockResolvedValue({ available: currentAvailable }) },
    inventoryEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const svc = new InventoryLedgerService({ $transaction: (fn: any) => fn(db) } as any, {
    getInventorySettings: jest.fn().mockResolvedValue({ warehousingEnabled: warehousing }),
  } as any);
  const applyMovement = jest.spyOn(svc, 'applyMovement').mockResolvedValue({
    skipped: false,
    inventoryQuantity: 6,
  } as any);
  return { svc, db, applyMovement };
}

describe('InventoryLedgerService.auditedVariantUpdate', () => {
  it('refuses a quantity edit with no warehouse on a warehousing org', async () => {
    const { svc, db } = build({ warehousing: true });

    await expect(
      svc.auditedVariantUpdate({
        orgId: ORG,
        variantId: VARIANT,
        data: { inventoryQuantity: 5 },
        reason: 'adjustment',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Nothing written — refusing beats guessing a warehouse.
    expect(db.productVariant.update).not.toHaveBeenCalled();
  });

  it('applies the difference against that warehouse and never writes the cache', async () => {
    const { svc, db, applyMovement } = build({ warehousing: true, currentAvailable: 2 });

    await svc.auditedVariantUpdate({
      orgId: ORG,
      variantId: VARIANT,
      data: { inventoryQuantity: 5, sku: 'NEW-SKU' },
      reason: 'adjustment',
      warehouseId: WAREHOUSE,
    });

    // Set-to semantics: 2 available at this warehouse, asked for 5 → +3.
    expect(applyMovement).toHaveBeenCalledTimes(1);
    expect(applyMovement.mock.calls[0][0]).toMatchObject({
      variantId: VARIANT,
      warehouseId: WAREHOUSE,
      toBucket: StockBucket.AVAILABLE,
      quantity: 3,
    });
    // The other fields still apply, but inventoryQuantity must be stripped —
    // applyMovement owns that column.
    const patch = db.productVariant.update.mock.calls[0][0].data;
    expect(patch.sku).toBe('NEW-SKU');
    expect(patch.inventoryQuantity).toBeUndefined();
  });

  it('refuses a location of another workspace, an inactive one, or an unknown one, moving nothing', async () => {
    for (const warehouseId of ['wh_other_org', 'wh_closed', 'wh_missing']) {
      const { svc, applyMovement } = build({ warehousing: true });

      await expect(
        svc.auditedVariantUpdate({
          orgId: ORG,
          variantId: VARIANT,
          data: { inventoryQuantity: 5 },
          reason: 'adjustment',
          warehouseId,
        }),
      ).rejects.toThrow(new NotFoundException('Location not found'));
      expect(applyMovement).not.toHaveBeenCalled();
    }
  });

  it('emits no movement when the warehouse already holds that quantity', async () => {
    const { svc, applyMovement } = build({ warehousing: true, currentAvailable: 5 });

    await svc.auditedVariantUpdate({
      orgId: ORG,
      variantId: VARIANT,
      data: { inventoryQuantity: 5 },
      reason: 'adjustment',
      warehouseId: WAREHOUSE,
    });

    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('leaves legacy orgs writing the quantity directly', async () => {
    const { svc, db, applyMovement } = build({ warehousing: false });

    await svc.auditedVariantUpdate({
      orgId: ORG,
      variantId: VARIANT,
      data: { inventoryQuantity: 5 },
      reason: 'adjustment',
    });

    expect(applyMovement).not.toHaveBeenCalled();
    expect(db.productVariant.update.mock.calls[0][0].data.inventoryQuantity).toBe(5);
    expect(db.inventoryEvent.create).toHaveBeenCalled();
  });
});
