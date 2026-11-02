import {
  catalogPricesIncludeTax,
  detectCatalogPricesIncludeTax,
} from './catalog-prices-include-tax.util';

/**
 * Whether a catalogue or typed price already contains GST decides whether a
 * ₹1,180 product is billed ₹1,180 or ₹1,392.40. The merchant's own choice
 * wins; until they make one, the store's Shopify orders are the best evidence.
 */
describe('catalogPricesIncludeTax', () => {
  function db(opts: { chosen?: boolean | null; storeTaxesIncluded?: boolean }) {
    return {
      organizationSettings: {
        findUnique: jest.fn().mockResolvedValue(
          opts.chosen === undefined ? null : { taxSettings: { pricesIncludeTax: opts.chosen } },
        ),
      },
      order: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            opts.storeTaxesIncluded === undefined ? null : { taxesIncluded: opts.storeTaxesIncluded },
          ),
      },
    };
  }

  it('follows the org’s choice over what its Shopify orders say', async () => {
    const included = db({ chosen: true, storeTaxesIncluded: false });
    const excluded = db({ chosen: false, storeTaxesIncluded: true });

    await expect(catalogPricesIncludeTax(included as any, 'org_1')).resolves.toBe(true);
    await expect(catalogPricesIncludeTax(excluded as any, 'org_1')).resolves.toBe(false);
    expect(excluded.order.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to the store’s Shopify orders while nothing is chosen', async () => {
    await expect(catalogPricesIncludeTax(db({ chosen: null, storeTaxesIncluded: true }) as any, 'org_1')).resolves.toBe(true);
    await expect(catalogPricesIncludeTax(db({ storeTaxesIncluded: false }) as any, 'org_1')).resolves.toBe(false);
  });

  it('reads prices as excluding GST with neither a choice nor a Shopify order', async () => {
    await expect(catalogPricesIncludeTax(db({}) as any, 'org_1')).resolves.toBe(false);
  });
});

describe('detectCatalogPricesIncludeTax', () => {
  it('reads the latest Shopify order the store itself took, not one the CRM pushed', async () => {
    const findFirst = jest.fn().mockResolvedValue({ taxesIncluded: true });

    await expect(detectCatalogPricesIncludeTax({ order: { findFirst } } as any, 'org_1')).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          taxesIncluded: { not: null },
          channel: { platform: 'SHOPIFY' },
          OR: [{ sourceName: null }, { sourceName: { not: 'collabo-crm' } }],
        }),
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('says nothing when no Shopify order has synced', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);

    await expect(detectCatalogPricesIncludeTax({ order: { findFirst } } as any, 'org_1')).resolves.toBeNull();
  });
});
