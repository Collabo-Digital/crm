import { extractOrderShopifySync } from './order-shopify-sync.util';

describe('extractOrderShopifySync', () => {
  it('returns null for a row with no metadata or no push record', () => {
    expect(extractOrderShopifySync(null)).toBeNull();
    expect(extractOrderShopifySync({})).toBeNull();
    expect(extractOrderShopifySync({ other: 1 })).toBeNull();
    expect(extractOrderShopifySync([] as any)).toBeNull();
  });

  it('hands the page a pushed order as SYNCED with when and as what', () => {
    expect(
      extractOrderShopifySync({
        shopifySync: {
          status: 'SYNCED',
          shopifyOrderId: '555',
          shopifyOrderName: '#1027',
          syncedAt: '2026-10-05T10:00:00.000Z',
          attempts: 1,
        },
      }),
    ).toEqual({
      status: 'SYNCED',
      shopifyOrderId: '555',
      shopifyOrderName: '#1027',
      syncedAt: '2026-10-05T10:00:00.000Z',
      attempts: 1,
    });
  });

  it('keeps the error and the claim time the page needs for FAILED and stuck', () => {
    expect(extractOrderShopifySync({ shopifySync: { status: 'FAILED', error: 'boom' } })).toEqual({
      status: 'FAILED',
      error: 'boom',
    });
    expect(
      extractOrderShopifySync({
        shopifySync: { status: 'PENDING', queuedAt: '2026-10-06T09:00:00.000Z' },
      }),
    ).toEqual({ status: 'PENDING', queuedAt: '2026-10-06T09:00:00.000Z' });
  });

  it('drops a record whose status is not one the page knows, and non-string fields', () => {
    expect(extractOrderShopifySync({ shopifySync: { status: 'WEIRD' } })).toBeNull();
    expect(
      extractOrderShopifySync({ shopifySync: { status: 'SYNCED', shopifyOrderName: 1027 } }),
    ).toEqual({ status: 'SYNCED' });
  });
});
