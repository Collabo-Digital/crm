import { draftLineAppliedDiscount } from './draft-line-discount.util';
import { DraftOrderService } from './draft-order.service';

describe('draftLineAppliedDiscount', () => {
  it('sends a whole-line discount as the per-unit amount Shopify multiplies back', () => {
    expect(draftLineAppliedDiscount(100, 2, 500)).toEqual({
      title: 'Discount',
      value: 50,
      valueType: 'FIXED_AMOUNT',
    });
  });

  // ₹100 off 3 units: 33.34 × 3 = 100.02 off, two paise under the quote
  // rather than one paisa over it.
  it('rounds an uneven split up, so Shopify never charges more than quoted', () => {
    expect(draftLineAppliedDiscount(100, 3, 500)?.value).toBe(33.34);
  });

  it('never discounts a unit below zero', () => {
    expect(draftLineAppliedDiscount(1000, 1, 999.99)?.value).toBe(999.99);
  });

  it('sends nothing for an undiscounted line', () => {
    expect(draftLineAppliedDiscount(0, 2, 500)).toBeUndefined();
    expect(draftLineAppliedDiscount(Number.NaN, 2, 500)).toBeUndefined();
  });
});

describe('DraftOrderService.buildShopifyInput — line discounts', () => {
  it('carries each line discount to the Shopify draft', async () => {
    const prisma = {
      draftOrder: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'draft_crm', note: null, tags: [], customerEmail: null, customer: null,
          shippingAddress: null, billingAddress: null,
          lineItems: [
            { title: 'Saree', variantTitle: null, quantity: 1, price: '1000', totalDiscount: '100', variant: { externalId: '4711' } },
            { title: 'Wrap', variantTitle: null, quantity: 2, price: '50', totalDiscount: '0', variant: null },
          ],
        }),
      },
    };
    const service = new DraftOrderService(
      prisma as any, { toNumber: (v: unknown) => Number(v) } as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
    );

    const input = await (service as any).buildShopifyInput('draft_crm');

    expect(input.lineItems[0]).toMatchObject({
      originalUnitPrice: '1000.00',
      appliedDiscount: { value: 100, valueType: 'FIXED_AMOUNT' },
    });
    expect(input.lineItems[1]).not.toHaveProperty('appliedDiscount');
  });
});
