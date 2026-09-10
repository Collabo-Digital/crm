import { ProductService } from './product.service';

/**
 * Vendor-scoped product stats and type filter. Every figure on the products
 * page derives from one `baseWhere`, so the risk here is not arithmetic — it is
 * that a vendor is handed the org's numbers because the scope never reached the
 * clause. These tests pin that it does.
 */

const ORG = 'org_1';
const VENDOR = 'Snowboard Vendor';

function build() {
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({ lowStockThreshold: 10 }),
    },
    product: {
      count: jest.fn().mockResolvedValue(4),
      findMany: jest.fn().mockResolvedValue([{ productType: 'Snowboard' }]),
    },
    productVariant: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { inventoryQuantity: 40 } }),
    },
  };
  const service = new ProductService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any,
  );
  return { service, prisma };
}

describe('ProductService.getStats vendor scoping', () => {
  it('scopes every count and the variant aggregate to the vendor', async () => {
    const { service, prisma } = build();

    await service.getStats(ORG, undefined, VENDOR);

    expect(prisma.product.count).toHaveBeenCalled();
    for (const [args] of prisma.product.count.mock.calls) {
      expect(args.where).toMatchObject({
        organizationId: ORG,
        deletedAt: null,
        vendor: VENDOR,
      });
    }
    // The inventory-units tile joins back through the product, so the scope has
    // to survive that hop too.
    const [aggArgs] = prisma.productVariant.aggregate.mock.calls[0];
    expect(aggArgs.where.product).toMatchObject({
      organizationId: ORG,
      vendor: VENDOR,
    });
  });

  it('keeps the org predicate alongside the vendor', async () => {
    const { service, prisma } = build();

    await service.getStats(ORG, undefined, 'vendor-from-another-org');

    for (const [args] of prisma.product.count.mock.calls) {
      // Without organizationId still present, the vendor string would be the
      // only thing between one tenant and another tenant's catalogue.
      expect(args.where.organizationId).toBe(ORG);
    }
  });

  it('omits the vendor predicate entirely for a non-vendor role', async () => {
    const { service, prisma } = build();

    await service.getStats(ORG);

    for (const [args] of prisma.product.count.mock.calls) {
      expect(args.where.organizationId).toBe(ORG);
      expect(args.where).not.toHaveProperty('vendor');
    }
  });

  it('still combines with the channel filter', async () => {
    const { service, prisma } = build();

    await service.getStats(ORG, 'ch_1', VENDOR);

    for (const [args] of prisma.product.count.mock.calls) {
      expect(args.where).toMatchObject({ channelId: 'ch_1', vendor: VENDOR });
    }
  });
});

describe('ProductService.getProductTypes vendor scoping', () => {
  it('offers a vendor only the types they actually have', async () => {
    const { service, prisma } = build();

    await service.getProductTypes(ORG, VENDOR);

    const [args] = prisma.product.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      organizationId: ORG,
      deletedAt: null,
      vendor: VENDOR,
    });
  });

  it('leaves the list org-wide for a non-vendor role', async () => {
    const { service, prisma } = build();

    await service.getProductTypes(ORG);

    const [args] = prisma.product.findMany.mock.calls[0];
    expect(args.where).not.toHaveProperty('vendor');
  });
});
