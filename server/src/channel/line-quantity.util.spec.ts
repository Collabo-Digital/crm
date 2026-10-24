import { quantityAfterEdits } from './line-quantity.util';

describe('quantityAfterEdits', () => {
  it('drops a line an order edit removed', () => {
    expect(quantityAfterEdits({ id: 11, quantity: 1, current_quantity: 0 }, [])).toBe(0);
  });

  it('keeps what is left of a line an edit reduced', () => {
    expect(quantityAfterEdits({ id: 11, quantity: 3, current_quantity: 2 }, [])).toBe(2);
  });

  it('keeps refunded units: the invoice carries them and a credit note reverses them', () => {
    const refunds = [{ refund_line_items: [{ line_item_id: 11, quantity: 1 }, { line_item_id: 12, quantity: 2 }] }];

    expect(quantityAfterEdits({ id: 11, quantity: 2, current_quantity: 1 }, refunds)).toBe(2);
    expect(quantityAfterEdits({ id: '12', quantity: 2, current_quantity: 0 }, refunds)).toBe(2);
  });

  it('takes off only the edited units when a line was both edited and refunded', () => {
    const refunds = [{ refund_line_items: [{ line_item_id: 11, quantity: 1 }] }];

    // Ordered 4, one taken off by an edit, one returned: 3 were sold.
    expect(quantityAfterEdits({ id: 11, quantity: 4, current_quantity: 2 }, refunds)).toBe(3);
  });

  it('never goes above what was ordered', () => {
    const refunds = [{ refund_line_items: [{ line_item_id: 11, quantity: 5 }] }];
    expect(quantityAfterEdits({ id: 11, quantity: 2, current_quantity: 2 }, refunds)).toBe(2);
  });

  it('keeps the ordered quantity when Shopify did not say', () => {
    expect(quantityAfterEdits({ id: 11, quantity: 2 }, undefined)).toBe(2);
    expect(quantityAfterEdits({ id: 11, quantity: 2, current_quantity: null }, [])).toBe(2);
  });
});
