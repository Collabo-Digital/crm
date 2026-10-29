import { GstCalculatorService } from './gst-calculator.service';

/**
 * The invoice totals identity is the thing the whole document hangs on:
 *
 *   grandTotal = subtotal + totalTax + shipping
 *
 * It was previously only asserted by reading the code. When `shipping` was
 * folded into `grandTotal` but not stored, the printed invoice's totals stopped
 * adding up and nothing caught it — so the identity gets a test.
 */
describe('GstCalculatorService', () => {
  let calculator: GstCalculatorService;

  beforeEach(() => {
    calculator = new GstCalculatorService();
  });

  describe('calculateLineItem', () => {
    it('splits an intra-state rate into equal CGST and SGST halves', () => {
      const result = calculator.calculateLineItem(
        { unitPrice: 1000, quantity: 2, discount: 0, gstRate: 18 },
        true,
      );

      expect(result.taxableValue).toBe(2000);
      expect(result.cgstRate).toBe(9);
      expect(result.sgstRate).toBe(9);
      expect(result.cgstAmount).toBe(180);
      expect(result.sgstAmount).toBe(180);
      expect(result.igstRate).toBe(0);
      expect(result.igstAmount).toBe(0);
      expect(result.totalTax).toBe(360);
      expect(result.totalAmount).toBe(2360);
    });

    it('applies the full rate as IGST inter-state', () => {
      const result = calculator.calculateLineItem(
        { unitPrice: 1000, quantity: 2, discount: 0, gstRate: 18 },
        false,
      );

      expect(result.igstRate).toBe(18);
      expect(result.igstAmount).toBe(360);
      expect(result.cgstAmount).toBe(0);
      expect(result.sgstAmount).toBe(0);
      expect(result.totalTax).toBe(360);
    });

    it('taxes the post-discount value, never the gross', () => {
      const result = calculator.calculateLineItem(
        { unitPrice: 1000, quantity: 1, discount: 100, gstRate: 18 },
        true,
      );

      expect(result.taxableValue).toBe(900);
      expect(result.totalTax).toBe(162); // 18% of 900, not of 1000
      expect(result.totalAmount).toBe(1062);
    });

    it('floors an over-large discount at zero rather than going negative', () => {
      // A negative taxable value would flow into the order total, decrement the
      // customer's lifetime value, and land in the GSTR-1 HSN summary and the
      // GSTR-3B rate buckets as fabricated negative output liability.
      const result = calculator.calculateLineItem(
        { unitPrice: 100, quantity: 1, discount: 500, gstRate: 18 },
        true,
      );

      expect(result.taxableValue).toBe(0);
      expect(result.totalTax).toBe(0);
      expect(result.totalAmount).toBe(0);
    });

    it('treats an explicit 0% rate as exempt, not as an error', () => {
      const result = calculator.calculateLineItem(
        { unitPrice: 500, quantity: 3, discount: 0, gstRate: 0 },
        true,
      );

      expect(result.taxableValue).toBe(1500);
      expect(result.totalTax).toBe(0);
      expect(result.totalAmount).toBe(1500);
    });
  });

  describe('calculateInclusiveLineItem', () => {
    it('backs the tax out of a price that already includes it', () => {
      const result = calculator.calculateInclusiveLineItem(
        { unitPrice: 1180, quantity: 1, discount: 0, gstRate: 18 },
        true,
      );

      expect(result.taxableValue).toBe(1000);
      expect(result.cgstAmount).toBe(90);
      expect(result.sgstAmount).toBe(90);
      expect(result.totalTax).toBe(180);
      expect(result.totalAmount).toBe(1180);
    });

    it('keeps taxable value plus tax equal to the amount charged when it does not divide evenly', () => {
      const result = calculator.calculateInclusiveLineItem(
        { unitPrice: 999, quantity: 3, discount: 100, gstRate: 18 },
        false,
      );

      expect(result.taxableValue).toBe(2455.08);
      expect(result.igstAmount).toBe(441.92);
      expect(result.taxableValue + result.totalTax).toBeCloseTo(2897, 2);
      expect(result.totalAmount).toBe(2897);
    });

    it('splits the remainder between CGST and SGST so they still add up', () => {
      const result = calculator.calculateInclusiveLineItem(
        { unitPrice: 999, quantity: 1, discount: 0, gstRate: 18 },
        true,
      );

      expect(result.taxableValue).toBe(846.61);
      expect(result.totalTax).toBe(152.39);
      expect([result.cgstAmount, result.sgstAmount]).toEqual([76.19, 76.2]);
    });

    it('leaves an exempt line untouched', () => {
      const result = calculator.calculateInclusiveLineItem(
        { unitPrice: 500, quantity: 2, discount: 0, gstRate: 0 },
        true,
      );

      expect(result.taxableValue).toBe(1000);
      expect(result.totalTax).toBe(0);
    });
  });

  describe('calculateInvoiceTotals', () => {
    const intraLines = () => [
      calculator.calculateLineItem(
        { unitPrice: 1000, quantity: 2, discount: 0, gstRate: 18 },
        true,
      ),
      calculator.calculateLineItem(
        { unitPrice: 500, quantity: 1, discount: 0, gstRate: 5 },
        true,
      ),
    ];

    it('holds grandTotal = subtotal + totalTax + shipping', () => {
      const totals = calculator.calculateInvoiceTotals(intraLines(), 0, 150);

      expect(totals.subtotal).toBe(2500);
      expect(totals.totalCgst).toBe(192.5); // 180 + 12.5
      expect(totals.totalSgst).toBe(192.5);
      expect(totals.totalTax).toBe(385);
      expect(totals.grandTotal).toBe(
        totals.subtotal + totals.totalTax + 150,
      );
      expect(totals.grandTotal).toBe(3035);
    });

    it('recovers the shipping addend from the stored figures', () => {
      // This is exactly the arithmetic the shipping_charge backfill migration
      // performs on rows written before the column existed.
      const totals = calculator.calculateInvoiceTotals(intraLines(), 0, 150);

      expect(totals.grandTotal - totals.subtotal - totals.totalTax).toBe(150);
    });

    it('reports totalDiscount without subtracting it a second time', () => {
      // Every line's discount is already inside its taxableValue, so subtotal
      // is post-discount. Deducting totalDiscount again here would understate
      // the grand total by the discount amount on every invoice.
      const lines = [
        calculator.calculateLineItem(
          { unitPrice: 1000, quantity: 1, discount: 100, gstRate: 18 },
          true,
        ),
      ];
      const totals = calculator.calculateInvoiceTotals(lines, 100, 0);

      expect(totals.subtotal).toBe(900);
      expect(totals.totalDiscount).toBe(100);
      expect(totals.grandTotal).toBe(1062); // 900 + 162, NOT 962
    });

    it('defaults shipping to zero so goods-only invoices are unaffected', () => {
      const totals = calculator.calculateInvoiceTotals(intraLines());

      expect(totals.grandTotal).toBe(totals.subtotal + totals.totalTax);
    });

    it('keeps IGST out of the CGST/SGST buckets', () => {
      const lines = [
        calculator.calculateLineItem(
          { unitPrice: 1000, quantity: 1, discount: 0, gstRate: 12 },
          false,
        ),
      ];
      const totals = calculator.calculateInvoiceTotals(lines, 0, 50);

      expect(totals.totalCgst).toBe(0);
      expect(totals.totalSgst).toBe(0);
      expect(totals.totalIgst).toBe(120);
      expect(totals.totalTax).toBe(120);
      expect(totals.grandTotal).toBe(1170);
    });
  });

  describe('toNullableNumber', () => {
    it('preserves the null-vs-zero distinction the rate resolver depends on', () => {
      expect(calculator.toNullableNumber(null)).toBeNull();
      expect(calculator.toNullableNumber(undefined)).toBeNull();
      expect(calculator.toNullableNumber(0)).toBe(0);
      // toNumber deliberately collapses both to 0 — that is why the nullable
      // variant exists.
      expect(calculator.toNumber(null)).toBe(0);
    });
  });

  describe('isIntraState', () => {
    it('is a plain state-code equality', () => {
      expect(calculator.isIntraState('27', '27')).toBe(true);
      expect(calculator.isIntraState('27', '29')).toBe(false);
    });
  });
});
