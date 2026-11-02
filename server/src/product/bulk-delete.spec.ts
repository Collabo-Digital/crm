import { ProductService } from './product.service';

/**
 * Warehousing orgs give every tracked variant a stock row, and stock rows
 * block a variant's delete (ON DELETE RESTRICT). Bulk delete never released
 * them, so for those orgs it always failed with "Related resource not found".
 */
function build(opts: { holding: string[] }) {
  const tx = {
    stockLevel: {
      findMany: jest.fn().mockResolvedValue(opts.holding.map((productId) => ({ variant: { productId } }))),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    product: { deleteMany: jest.fn(async ({ where }: any) => ({ count: where.id.in.length })) },
  };
  const prisma = {
    product: {
      findMany: jest.fn(async ({ where }: any) =>
        where.status === 'ARCHIVED'
          ? [{ id: 'p_empty' }, { id: 'p_stocked' }]
          : [
            { id: 'p_empty', channel: { platform: 'MANUAL' } },
            { id: 'p_stocked', channel: { platform: 'MANUAL' } },
          ],
      ),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const service = new ProductService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  );
  return { service, tx };
}

describe('ProductService.bulkDelete', () => {
  it('releases empty stock rows and deletes, skipping a product that still holds stock', async () => {
    const { service, tx } = build({ holding: ['p_stocked'] });

    const result = await service.bulkDelete('org_1', ['p_empty', 'p_stocked']);

    expect(tx.stockLevel.deleteMany).toHaveBeenCalledWith({
      where: { variant: { productId: { in: ['p_empty'] } } },
    });
    expect(tx.product.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['p_empty'] }, organizationId: 'org_1' },
    });
    expect(tx.stockLevel.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.product.deleteMany.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({
      ok: ['p_empty'],
      deleted: 1,
      skipped: [{ id: 'p_stocked', reason: 'Still has stock. Adjust it to zero before deleting.' }],
    });
  });

  it('deletes nothing when every selected product still holds stock', async () => {
    const { service, tx } = build({ holding: ['p_empty', 'p_stocked'] });

    const result = await service.bulkDelete('org_1', ['p_empty', 'p_stocked']);

    expect(tx.product.deleteMany).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.skipped).toHaveLength(2);
  });
});
