import { ShopifySyncService } from './shopify-sync.service';

/**
 * Products stored before `products.handle` existed keep a null handle until
 * something fills it: the incremental pull never fetches an unchanged product
 * again. `backfillProductHandles` reads just the handles and writes just them.
 */
describe('ShopifySyncService.backfillProductHandles', () => {
  function build(rows: Array<{ id: string; externalId: string }>, nodes: Array<{ id: string; handle: string | null } | null>) {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const graphql = { request: jest.fn().mockResolvedValue({ nodes }) };
    const service = new ShopifySyncService(
      prisma as any, {} as any, {} as any, graphql as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    const s = service as any;
    jest.spyOn(s.logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(s.logger, 'warn').mockImplementation(() => undefined);
    const run = () => s.backfillProductHandles('ch_1', async () => ({ shop: 'x', token: 't' }));
    return { prisma, graphql, run, warn };
  }

  it('asks Shopify for the missing handles and writes only the handle, only where still null', async () => {
    const { prisma, graphql, run } = build(
      [
        { id: 'p1', externalId: '8790530195508' },
        { id: 'p2', externalId: '8813250412596' },
      ],
      [
        { id: 'gid://shopify/Product/8790530195508', handle: 'the-videographer-snowboard' },
        { id: 'gid://shopify/Product/8813250412596', handle: 'tester' },
      ],
    );

    await run();

    expect(prisma.product.findMany).toHaveBeenCalledWith({ where: { channelId: 'ch_1', handle: null }, select: { id: true, externalId: true } });
    expect(graphql.request).toHaveBeenCalledTimes(1);
    expect(graphql.request.mock.calls[0][2]).toEqual({ ids: ['gid://shopify/Product/8790530195508', 'gid://shopify/Product/8813250412596'] });
    expect(prisma.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p1', handle: null }, data: { handle: 'the-videographer-snowboard' } });
    expect(prisma.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p2', handle: null }, data: { handle: 'tester' } });
  });

  it('does not call Shopify when every product already has a handle', async () => {
    const { graphql, prisma, run } = build([], []);
    await run();
    expect(graphql.request).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('skips CRM-made products not pushed yet, whose manual_ id is no Shopify gid', async () => {
    const { graphql, run } = build(
      [
        { id: 'p1', externalId: 'manual_3f1c' },
        { id: 'p2', externalId: '42' },
      ],
      [{ id: 'gid://shopify/Product/42', handle: 'h' }],
    );
    await run();
    expect(graphql.request.mock.calls[0][2]).toEqual({ ids: ['gid://shopify/Product/42'] });
  });

  it('leaves products Shopify no longer has (null node) untouched', async () => {
    const { prisma, run } = build([{ id: 'p1', externalId: '7' }], [null]);
    await run();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('asks in batches of 250 ids', async () => {
    const rows = Array.from({ length: 251 }, (_, i) => ({ id: `p${i}`, externalId: String(1000 + i) }));
    const { graphql, run } = build(rows, []);
    await run();
    expect(graphql.request).toHaveBeenCalledTimes(2);
    expect(graphql.request.mock.calls[0][2].ids).toHaveLength(250);
    expect(graphql.request.mock.calls[1][2].ids).toHaveLength(1);
  });

  it('logs and returns when Shopify fails, so the products sync still completes', async () => {
    const { graphql, run, warn } = build([{ id: 'p1', externalId: '7' }], []);
    graphql.request.mockRejectedValueOnce(new Error('Throttled'));
    await expect(run()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Throttled'));
  });
});
