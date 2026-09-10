import { OrderService } from './order.service';
import { ChannelPlatform, StockBucket } from '@prisma/client';

/**
 * Cancelling a MANUAL order must restock through the ledger, into a warehouse.
 *
 * It used to do `inventoryQuantity: { increment }` straight onto the variant.
 * For a warehousing org that cache is derived from stock_levels, so the
 * increment left the real buckets untouched, attributed the units to no
 * warehouse, told Shopify nothing, and was silently wiped by the next
 * applyMovement, which recomputes the cache from stock_levels.
 */

const ORG = 'org_1';
const ORDER = 'order_1';
const USER = 'user_1';

function build({ warehousing, dispatchWarehouseId = null as string | null }) {
  const updated = { id: ORDER, dispatchWarehouseId };
  const tx: any = {
    order: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(updated),
    },
    orderLineItem: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'li_1', quantity: 3, variant: { id: 'var_1', trackQuantity: true, inventoryQuantity: 5 } },
      ]),
    },
    warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'wh_default' }) },
    productVariant: { update: jest.fn().mockResolvedValue({ inventoryQuantity: 8 }) },
    inventoryEvent: { create: jest.fn().mockResolvedValue(undefined) },
    orderTimelineEvent: { create: jest.fn().mockResolvedValue(undefined) },
  };
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const ledger = {
    isWarehousingEnabled: jest.fn().mockResolvedValue(warehousing),
    applyMovement: jest.fn().mockResolvedValue({ skipped: false, inventoryQuantity: 8 }),
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const settings = {
    getProductSettings: jest.fn().mockResolvedValue({ trackQuantityGlobally: true }),
  };

  const service = new OrderService(
    prisma, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, settings as any, { recomputeForCustomer: jest.fn() } as any,
    ledger as any, {} as any /* fx */, queue as any,
  );
  // A MANUAL order with nothing to cancel remotely.
  (service as any).loadOrderWithChannel = jest.fn().mockResolvedValue({
    id: ORDER,
    cancelledAt: null,
    customerId: null,
    channel: { id: 'ch_manual', platform: ChannelPlatform.MANUAL },
  });
  return { service, tx, ledger, queue };
}

const dto = { reason: 'CUSTOMER' as any, restock: true };

describe('OrderService.cancel restock', () => {
  it('moves units into the dispatch warehouse through the ledger', async () => {
    const { service, tx, ledger, queue } = build({
      warehousing: true,
      dispatchWarehouseId: 'wh_dispatch',
    });

    await service.cancel(ORDER, ORG, USER, dto as any);

    expect(ledger.applyMovement).toHaveBeenCalledTimes(1);
    const [args] = ledger.applyMovement.mock.calls[0];
    expect(args).toMatchObject({
      orgId: ORG,
      variantId: 'var_1',
      warehouseId: 'wh_dispatch',
      toBucket: StockBucket.AVAILABLE,
      quantity: 3,
      reason: 'restock',
    });
    // Idempotent against a retried cancel.
    expect(args.idempotencyKey).toBe(`restock:${ORDER}:li_1`);
    // The cache must NOT be written directly.
    expect(tx.productVariant.update).not.toHaveBeenCalled();
    // Shopify has to learn the units are sellable again.
    expect(queue.add).toHaveBeenCalledWith(
      'push-availability',
      expect.objectContaining({ organizationId: ORG, variantIds: ['var_1'] }),
      expect.anything(),
    );
  });

  it('falls back to the default warehouse when dispatch was never stamped', async () => {
    const { service, ledger } = build({ warehousing: true });

    await service.cancel(ORDER, ORG, USER, dto as any);

    expect(ledger.applyMovement.mock.calls[0][0]).toMatchObject({
      warehouseId: 'wh_default',
    });
  });

  it('keeps the legacy single-quantity path for non-warehousing orgs', async () => {
    const { service, tx, ledger, queue } = build({ warehousing: false });

    await service.cancel(ORDER, ORG, USER, dto as any);

    expect(ledger.applyMovement).not.toHaveBeenCalled();
    expect(tx.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'var_1' },
      data: { inventoryQuantity: { increment: 3 } },
      select: { inventoryQuantity: true },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
