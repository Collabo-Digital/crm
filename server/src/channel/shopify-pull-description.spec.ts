import { ShopifySyncService } from './shopify-sync.service';

/**
 * Descriptions pulled from Shopify (sync and products/* webhooks) are stored
 * sanitised. The difference that makes must not queue a push back: the pull
 * only ever stamps a product SYNCED, never OUT_OF_SYNC.
 */

const ORG = 'org_1';

function build() {
  const prisma = {
    product: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn(() => Promise.resolve({ id: 'p1' })),
    },
    productVariant: { findMany: jest.fn(() => Promise.resolve([])) },
    productImage: { findMany: jest.fn(() => Promise.resolve([])) },
    $executeRaw: jest.fn(() => Promise.resolve(1)),
  };
  const pushEnqueuer = {
    enqueueProductPush: jest.fn(),
    enqueueProductPushMany: jest.fn(),
    enqueueBulkProductPush: jest.fn(),
  };
  const inventoryLedger = { isWarehousingEnabled: jest.fn(() => Promise.resolve(true)) };
  const orgSettings = { getProductSettings: jest.fn(() => Promise.resolve({})) };
  // prisma, shopifyOAuth, loyalty, graphql, pushEnqueuer, inventoryLedger,
  // locationSync, config, invoiceService, orgSettings, fx, draftMirrorQueue, commerceEvents
  const service = new ShopifySyncService(
    prisma as never, {} as never, {} as never, {} as never, pushEnqueuer as never,
    inventoryLedger as never, {} as never, {} as never, {} as never, orgSettings as never,
    {} as never, {} as never, {} as never,
  );
  return { service, prisma, pushEnqueuer };
}

const payload = (extra: Record<string, unknown>) => ({
  id: 9,
  title: 'Shirt',
  updated_at: '2026-10-25T10:00:00Z',
  variants: [],
  images: [],
  ...extra,
});

describe('ShopifySyncService — descriptions pulled from Shopify', () => {
  it('stores a sanitised copy and queues no push', async () => {
    const { service, prisma, pushEnqueuer } = build();

    await service.upsertProduct(
      'ch',
      ORG,
      payload({ body_html: '<p>Linen</p><iframe src="https://www.youtube.com/embed/x"></iframe><script>x()</script>' }),
    );

    const upsert = prisma.product.upsert.mock.calls[0] as unknown as [
      { create: { bodyHtml: unknown }; update: { bodyHtml: unknown } },
    ];
    expect(upsert[0].create.bodyHtml).toBe('<p>Linen</p>');
    expect(upsert[0].update.bodyHtml).toBe('<p>Linen</p>');
    for (const fn of Object.values(pushEnqueuer)) expect(fn).not.toHaveBeenCalled();
    const stamps = prisma.$executeRaw.mock.calls as unknown as Array<[{ strings: string[] }]>;
    expect(stamps).toHaveLength(1);
    expect(stamps[0][0].strings.join('')).not.toContain('OUT_OF_SYNC');
  });

  it('leaves the stored description alone when the payload has none', async () => {
    const { service, prisma } = build();

    await service.upsertProduct('ch', ORG, payload({}));

    const upsert = prisma.product.upsert.mock.calls[0] as unknown as [
      { update: { bodyHtml: unknown } },
    ];
    expect(upsert[0].update.bodyHtml).toBeUndefined();
  });

  it('stores a cleared description as cleared', async () => {
    const { service, prisma } = build();

    await service.upsertProduct('ch', ORG, payload({ body_html: null }));

    const upsert = prisma.product.upsert.mock.calls[0] as unknown as [
      { update: { bodyHtml: unknown } },
    ];
    expect(upsert[0].update.bodyHtml).toBeNull();
  });
});
