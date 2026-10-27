import { StockBucket } from '@prisma/client';
import { InventoryService } from './inventory.service';

/**
 * A "set to" stock count must be worked out from the level read under the
 * same variant lock as the movement that applies it.
 *
 * It used to read the level first, outside any transaction, and move stock in
 * a second one. A POS sale or a Shopify inventory update committing between
 * the two left a "set to 10" count at 9 or 11. The bulk stocktake read every
 * level before its transaction, which widened that window to the whole batch.
 */

const ORG = 'org_1';
const USER = 'user_1';
const WH = { id: 'wh_1', name: 'Main Store - Kochi', code: 'MSKOCH' };

function build(levels: Array<{ variantId: string; available: number }>) {
  const calls: string[] = [];
  const level = (variantId: string) => {
    const l = levels.find((x) => x.variantId === variantId);
    return l ? { ...l, reserved: 0, qc: 0, damaged: 0 } : null;
  };
  const tx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock:${String(values[0])}`);
      expect(strings.join('?')).toContain('FOR UPDATE');
      return Promise.resolve([]);
    }),
    stockLevel: {
      findFirst: jest.fn(({ where }: { where: { variantId: string } }) => {
        calls.push(`read:${where.variantId}`);
        return Promise.resolve(level(where.variantId));
      }),
      findMany: jest.fn(({ where }: { where: { variantId: { in: string[] } } }) => {
        calls.push('read:batch');
        return Promise.resolve(where.variantId.in.map(level).filter(Boolean));
      }),
    },
  };
  const prisma = {
    warehouse: { findFirst: jest.fn().mockResolvedValue(WH) },
    productVariant: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id })),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id }))),
      ),
    },
    // Reading here, outside the transaction, is the bug.
    stockLevel: { findFirst: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const applyMovement = jest.fn((args: { variantId: string }) => {
    calls.push(`move:${args.variantId}`);
    return Promise.resolve({ skipped: false, inventoryQuantity: 10 });
  });
  const ledger = { applyMovement, isWarehousingEnabled: jest.fn().mockResolvedValue(true) };
  const service = new InventoryService(
    prisma as never,
    {} as never,
    ledger as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const push = jest
    .spyOn(service, 'enqueueAvailabilityPush')
    .mockResolvedValue(undefined);
  return { service, prisma, tx, calls, applyMovement, push };
}

describe('InventoryService.createAdjustment with setTo', () => {
  it('locks the variant, then reads the level and moves stock in that same transaction', async () => {
    const { service, prisma, tx, calls, applyMovement } = build([
      { variantId: 'v1', available: 9 },
    ]);

    await service.createAdjustment(ORG, USER, {
      variantId: 'v1',
      warehouseId: WH.id,
      bucket: StockBucket.AVAILABLE,
      setTo: 10,
    });

    expect(calls).toEqual(['lock:v1', 'read:v1', 'move:v1']);
    expect(prisma.stockLevel.findFirst).not.toHaveBeenCalled();
    expect(applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 1, toBucket: StockBucket.AVAILABLE, fromBucket: null }),
      tx,
    );
  });

  it('moves nothing and pushes nothing when the count already matches', async () => {
    const { service, applyMovement, push } = build([{ variantId: 'v1', available: 10 }]);

    const out = await service.createAdjustment(ORG, USER, {
      variantId: 'v1',
      warehouseId: WH.id,
      bucket: StockBucket.AVAILABLE,
      setTo: 10,
    });

    expect(out).toEqual({ ok: true, changed: false, inventoryQuantity: undefined });
    expect(applyMovement).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('still applies a plain delta on the same transaction', async () => {
    const { service, tx, applyMovement } = build([]);

    await service.createAdjustment(ORG, USER, {
      variantId: 'v1',
      warehouseId: WH.id,
      bucket: StockBucket.DAMAGED,
      delta: -2,
    });

    expect(applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 2, fromBucket: StockBucket.DAMAGED, toBucket: null }),
      tx,
    );
  });
});

describe('InventoryService.createAdjustmentsBulk with setTo', () => {
  it('locks every variant in id order before reading any level, all inside the transaction', async () => {
    const { service, prisma, calls, applyMovement, tx } = build([
      { variantId: 'v_a', available: 4 },
      { variantId: 'v_b', available: 9 },
    ]);

    await service.createAdjustmentsBulk(ORG, USER, {
      warehouseId: WH.id,
      items: [
        { variantId: 'v_b', bucket: StockBucket.AVAILABLE, setTo: 7 },
        { variantId: 'v_a', bucket: StockBucket.AVAILABLE, setTo: 6 },
      ],
    });

    expect(calls).toEqual(['lock:v_a', 'lock:v_b', 'read:batch', 'move:v_a', 'move:v_b']);
    expect(prisma.stockLevel.findMany).not.toHaveBeenCalled();
    expect(applyMovement).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ variantId: 'v_a', quantity: 2, toBucket: StockBucket.AVAILABLE }),
      tx,
    );
    expect(applyMovement).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ variantId: 'v_b', quantity: 2, fromBucket: StockBucket.AVAILABLE }),
      tx,
    );
  });

  it('locks a variant once even when it has lines in two buckets', async () => {
    const { service, calls } = build([{ variantId: 'v1', available: 1 }]);

    await service.createAdjustmentsBulk(ORG, USER, {
      warehouseId: WH.id,
      items: [
        { variantId: 'v1', bucket: StockBucket.AVAILABLE, setTo: 3 },
        { variantId: 'v1', bucket: StockBucket.DAMAGED, delta: 1 },
      ],
    });

    expect(calls.filter((c) => c.startsWith('lock:'))).toEqual(['lock:v1']);
  });
});
