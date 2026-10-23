import { ShopifyWebhookController } from './shopify-webhook.controller';

/**
 * `products/delete` must soft-delete, not mark ARCHIVED.
 *
 * ARCHIVED is one of Shopify's own product statuses and arrives through the
 * normal product sync, so writing it on delete made a deleted product
 * indistinguishable from an archived one — and left it in the catalogue
 * permanently, because listings filter on `deletedAt`. Production on
 * 2026-09-04: Shopify held 0 archived products, the CRM held 128, every one of
 * them deleted upstream.
 */

const CHANNEL = 'ch_1';

function build(found: unknown) {
  const prisma = {
    product: {
      findFirst: jest.fn().mockResolvedValue(found),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  // prisma, encryption, syncService, checkouts, config, inventoryLedger
  const controller = new ShopifyWebhookController(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { controller, prisma };
}

/** `handleProductDelete` is private; the webhook route is the public surface. */
function callDelete(controller: ShopifyWebhookController, id: number) {
  return (controller as any).handleProductDelete(CHANNEL, { id });
}

describe('ShopifyWebhookController products/delete', () => {
  it('soft-deletes the product rather than marking it ARCHIVED', async () => {
    const { controller, prisma } = build({ id: 'prod_1' });

    await callDelete(controller, 12345);

    expect(prisma.product.update).toHaveBeenCalledTimes(1);
    const call = prisma.product.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'prod_1' });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
    // The status must be left alone — ARCHIVED is a real Shopify status that
    // the product sync owns, and overwriting it here loses that information.
    expect(call.data.status).toBeUndefined();
  });

  it('looks up only products that are not already soft-deleted', async () => {
    const { controller, prisma } = build({ id: 'prod_1' });

    await callDelete(controller, 12345);

    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { channelId: CHANNEL, externalId: '12345', deletedAt: null },
    });
  });

  it('is a no-op when the product is unknown', async () => {
    const { controller, prisma } = build(null);

    await callDelete(controller, 999);

    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});
