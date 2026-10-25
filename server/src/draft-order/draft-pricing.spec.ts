import { GstCalculatorService } from '../gst/gst-calculator.service';
import { DraftOrderService } from './draft-order.service';

/**
 * A WhatsApp cart becomes a draft priced from the catalogue, and its total is
 * what the payment link and the WhatsApp Pay bill charge. In a store whose
 * prices include GST, adding GST on top charged the customer 18% more than
 * the price on the product.
 */
describe('DraftOrderService.create pricing', () => {
  /**
   * `pricesIncludeTax` is the org's "Catalogue prices include GST" choice
   * (null: not made); `storeTaxesIncluded` is what its latest Shopify order
   * says (null: none synced).
   */
  function build(opts: { storeTaxesIncluded: boolean | null; pricesIncludeTax?: boolean | null }) {
    const created: any[] = [];
    const tx = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch_manual' }) },
      productVariant: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'v_1',
            title: 'Default Title',
            sku: 'SHIRT',
            price: 1180,
            gstRate: null,
            taxable: true,
            product: { id: 'p_1', title: 'Shirt', gstRate: 18 },
          },
        ]),
      },
      organization: { findUnique: jest.fn().mockResolvedValue({ gstEnabled: true, currency: 'INR' }) },
      organizationGstin: { findFirst: jest.fn().mockResolvedValue({ stateCode: '29' }) },
      organizationSettings: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ taxSettings: { pricesIncludeTax: opts.pricesIncludeTax ?? null } }),
      },
      order: {
        findFirst: jest
          .fn()
          .mockResolvedValue(opts.storeTaxesIncluded === null ? null : { taxesIncluded: opts.storeTaxesIncluded }),
      },
      draftOrder: {
        create: jest.fn(({ data }: any) => {
          created.push(data);
          return Promise.resolve({ id: 'd_1', ...data });
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      draftOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'd_1' }) },
    };
    const service = new DraftOrderService(
      prisma as any,
      new GstCalculatorService(),
      { resolveLineGstRates: jest.fn().mockResolvedValue([18]) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { getOrderSettings: jest.fn().mockResolvedValue({ autoSyncToShopify: false }) } as any,
    );
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    return { service, created, tx };
  }

  it('charges the catalogue price of a tax-inclusive store, with the GST inside it', async () => {
    const { service, created } = build({ storeTaxesIncluded: true });

    await service.create('org_1', 'u_1', { lineItems: [{ productVariantId: 'v_1', quantity: 1 }] } as any);

    expect(created[0]).toEqual(
      expect.objectContaining({ subtotalPrice: 1000, totalTax: 180, totalPrice: 1180 }),
    );
    expect(created[0].metadata).toEqual(expect.objectContaining({ pricesIncludeTax: true }));
    // The line keeps the catalogue price, which is what the Shopify draft shows.
    expect(created[0].lineItems.create[0].price).toBe(1180);
  });

  it('still adds GST on top when the store prices exclude it', async () => {
    const { service, created } = build({ storeTaxesIncluded: false });

    await service.create('org_1', 'u_1', { lineItems: [{ productVariantId: 'v_1', quantity: 1 }] } as any);

    expect(created[0]).toEqual(expect.objectContaining({ totalTax: 212.4, totalPrice: 1392.4 }));
    expect(created[0].metadata.pricesIncludeTax).toBeUndefined();
  });

  it('reads a typed price on the same basis as the catalogue, as the order form previews it', async () => {
    const { service, created } = build({ storeTaxesIncluded: true });

    await service.create('org_1', 'u_1', {
      lineItems: [{ productVariantId: 'v_1', quantity: 1, unitPriceOverride: 1180 }],
    } as any);

    expect(created[0]).toEqual(expect.objectContaining({ subtotalPrice: 1000, totalTax: 180, totalPrice: 1180 }));
    expect(created[0].metadata.pricesIncludeTax).toBe(true);
  });

  it('adds GST on top of a typed price when prices exclude it', async () => {
    const { service, created } = build({ storeTaxesIncluded: false });

    await service.create('org_1', 'u_1', {
      lineItems: [{ productVariantId: 'v_1', quantity: 1, unitPriceOverride: 1000 }],
    } as any);

    expect(created[0]).toEqual(expect.objectContaining({ subtotalPrice: 1000, totalTax: 180, totalPrice: 1180 }));
  });

  it('follows the org’s choice that prices include GST, even with no Shopify order to go by', async () => {
    const { service, created } = build({ storeTaxesIncluded: null, pricesIncludeTax: true });

    await service.create('org_1', 'u_1', { lineItems: [{ productVariantId: 'v_1', quantity: 1 }] } as any);

    expect(created[0]).toEqual(expect.objectContaining({ subtotalPrice: 1000, totalTax: 180, totalPrice: 1180 }));
  });

  it('lets the org’s choice override what its Shopify orders say', async () => {
    const { service, created, tx } = build({ storeTaxesIncluded: true, pricesIncludeTax: false });

    await service.create('org_1', 'u_1', { lineItems: [{ productVariantId: 'v_1', quantity: 1 }] } as any);

    expect(created[0]).toEqual(expect.objectContaining({ totalTax: 212.4, totalPrice: 1392.4 }));
    expect(created[0].metadata.pricesIncludeTax).toBeUndefined();
    expect(tx.order.findFirst).not.toHaveBeenCalled();
  });

  it('adds GST on top while nothing is chosen and no Shopify order has synced', async () => {
    const { service, created } = build({ storeTaxesIncluded: null });

    await service.create('org_1', 'u_1', { lineItems: [{ productVariantId: 'v_1', quantity: 1 }] } as any);

    expect(created[0]).toEqual(expect.objectContaining({ totalPrice: 1392.4 }));
  });

  it('reads the store setting from its own Shopify orders, not ones the CRM pushed', async () => {
    const { service, tx } = build({ storeTaxesIncluded: null });

    await service.create('org_1', 'u_1', { lineItems: [{ productVariantId: 'v_1', quantity: 1 }] } as any);

    expect(tx.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          taxesIncluded: { not: null },
          channel: { platform: 'SHOPIFY' },
          OR: [{ sourceName: null }, { sourceName: { not: 'collabo-crm' } }],
        }),
      }),
    );
  });
});
