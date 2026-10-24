import { DashboardService } from './dashboard.service';

/**
 * "Top selling products" grouped line items by Shopify product id, so every
 * counter sale and completed draft (no Shopify id on their lines) was left
 * out, and cancelled or unpaid orders counted as sold.
 */
describe('DashboardService top selling products', () => {
  const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };

  function build() {
    const prisma = {
      orderLineItem: {
        groupBy: jest.fn().mockResolvedValue([
          // Counter sale: a CRM variant, no Shopify product id.
          { variantId: 'v_saree_red', externalProductId: null, _sum: { quantity: 5 }, _count: 3 },
          // Shopify sale of another variant of the same product.
          { variantId: 'v_saree_blue', externalProductId: '111', _sum: { quantity: 2 }, _count: 2 },
          // Shopify line whose variant has since been deleted.
          { variantId: null, externalProductId: '222', _sum: { quantity: 4 }, _count: 4 },
        ]),
      },
      productVariant: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v_saree_red', productId: 'p_saree' },
          { id: 'v_saree_blue', productId: 'p_saree' },
        ]),
      },
      product: {
        findMany: jest.fn(async ({ where }: any) =>
          where.externalId
            ? [{ id: 'p_kurta', externalId: '222' }]
            : [
              { id: 'p_saree', externalId: 'manual_x', title: 'Saree', images: [], variants: [{ price: '900', inventoryQuantity: 3 }] },
              { id: 'p_kurta', externalId: '222', title: 'Kurta', images: [], variants: [{ price: '400', inventoryQuantity: 9 }] },
            ],
        ),
      },
    };
    return { service: new DashboardService(prisma as any), prisma };
  }

  it('counts counter sales and folds variants into their product', async () => {
    const { service } = build();

    const top = await (service as any).getTopSellingProducts('org_1', {}, window, 5);

    expect(top.map((p: any) => [p.title, p.totalQuantitySold, p.totalOrders])).toEqual([
      ['Saree', 7, 5],
      ['Kurta', 4, 4],
    ]);
    expect(top[0].externalProductId).toBe('manual_x');
  });

  it('uses the sales filter: cancelled and unpaid orders sold nothing', async () => {
    const { service, prisma } = build();

    await (service as any).getTopSellingProducts('org_1', {}, window, 5);

    expect(prisma.orderLineItem.groupBy.mock.calls[0][0].where.order).toMatchObject({
      organizationId: 'org_1',
      cancelledAt: null,
      financialStatus: { in: expect.any(Array) },
    });
  });
});
