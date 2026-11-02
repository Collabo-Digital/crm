import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { getFinancialYear } from '../common/utils/zoned-date.util';

export interface GstCalculationInput {
  unitPrice: number;
  quantity: number;
  discount: number;
  gstRate: number; // Full GST percentage (e.g. 18)
}

export interface GstCalculationResult {
  taxableValue: number;
  gstRate: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
  totalTax: number;
  totalAmount: number;
}

export interface InvoiceTotals {
  subtotal: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalTax: number;
  totalDiscount: number;
  grandTotal: number;
}

@Injectable()
export class GstCalculatorService {
  /**
   * Determine if a transaction is intra-state (CGST+SGST) or inter-state (IGST)
   */
  isIntraState(sellerStateCode: string, placeOfSupplyCode: string): boolean {
    return sellerStateCode === placeOfSupplyCode;
  }

  /**
   * Calculate GST for a single line item
   *
   * CGST+SGST (intra-state): each is half the rate
   *   e.g. 18% GST → 9% CGST + 9% SGST
   *
   * IGST (inter-state): full rate applied as IGST
   *   e.g. 18% GST → 18% IGST
   */
  calculateLineItem(
    input: GstCalculationInput,
    isIntraState: boolean,
  ): GstCalculationResult {
    // Floored at zero. A discount larger than the line total would otherwise
    // produce a negative taxable value and negative CGST/SGST/IGST, which flows
    // into the order total, decrements the customer's lifetime value, and lands
    // in the GSTR-1 HSN summary and GSTR-3B rate buckets as fabricated negative
    // output liability. Callers reject over-large discounts up front; this is
    // the arithmetic backstop.
    const taxableValue = Math.max(
      0,
      this.round(input.unitPrice * input.quantity - input.discount),
    );

    const gstRate = input.gstRate;

    let cgstRate = 0;
    let cgstAmount = 0;
    let sgstRate = 0;
    let sgstAmount = 0;
    let igstRate = 0;
    let igstAmount = 0;

    if (isIntraState) {
      // Intra-state: split into CGST + SGST
      cgstRate = this.round(gstRate / 2);
      sgstRate = this.round(gstRate / 2);
      cgstAmount = this.round((taxableValue * cgstRate) / 100);
      sgstAmount = this.round((taxableValue * sgstRate) / 100);
    } else {
      // Inter-state: full rate as IGST
      igstRate = gstRate;
      igstAmount = this.round((taxableValue * igstRate) / 100);
    }

    const totalTax = this.round(cgstAmount + sgstAmount + igstAmount);
    const totalAmount = this.round(taxableValue + totalTax);

    return {
      taxableValue,
      gstRate,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      igstRate,
      igstAmount,
      totalTax,
      totalAmount,
    };
  }

  /**
   * GST for a line whose price already INCLUDES the tax: a Shopify store with
   * "taxes included", or a catalogue priced at MRP.
   *
   * The line's amount (unit price × quantity − discount) is what the customer
   * pays, so the taxable value is backed out of it (amount × 100 / (100 +
   * rate)) and the tax is what is left. Taking the remainder keeps taxable +
   * tax equal to the amount charged; CGST takes half and SGST the rest, so the
   * two can differ by a paisa.
   */
  calculateInclusiveLineItem(
    input: GstCalculationInput,
    isIntraState: boolean,
  ): GstCalculationResult {
    const amount = Math.max(
      0,
      this.round(input.unitPrice * input.quantity - input.discount),
    );
    const gstRate = input.gstRate;
    const taxableValue = this.round((amount * 100) / (100 + gstRate));
    const totalTax = this.round(amount - taxableValue);

    let cgstRate = 0;
    let cgstAmount = 0;
    let sgstRate = 0;
    let sgstAmount = 0;
    let igstRate = 0;
    let igstAmount = 0;

    if (isIntraState) {
      cgstRate = this.round(gstRate / 2);
      sgstRate = this.round(gstRate / 2);
      cgstAmount = this.round(totalTax / 2);
      sgstAmount = this.round(totalTax - cgstAmount);
    } else {
      igstRate = gstRate;
      igstAmount = totalTax;
    }

    return {
      taxableValue,
      gstRate,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      igstRate,
      igstAmount,
      totalTax,
      totalAmount: amount,
    };
  }

  /**
   * Calculate invoice totals from an array of line item results.
   *
   * `totalDiscount` is INFORMATIONAL only and must be the sum of the discounts
   * already applied to those line items — every line's discount is subtracted
   * inside `calculateLineItem`, so it is already reflected in `subtotal` and
   * must not be subtracted a second time here. (Passing `Order.totalDiscounts`
   * for a Shopify order would double-count, because that field already
   * includes the per-line allocations.)
   *
   * `shipping` IS added to the grand total: it is part of what the customer
   * owes, and omitting it made `Invoice.grandTotal` disagree with
   * `Order.totalPrice` on every shipped order. Shipping is not taxed here —
   * treating it as a composite supply would change the tax charged and is a
   * deliberate decision, not a bug fix.
   */
  calculateInvoiceTotals(
    lineItems: GstCalculationResult[],
    totalDiscount: number = 0,
    shipping: number = 0,
  ): InvoiceTotals {
    const subtotal = this.round(
      lineItems.reduce((sum, item) => sum + item.taxableValue, 0),
    );
    const totalCgst = this.round(
      lineItems.reduce((sum, item) => sum + item.cgstAmount, 0),
    );
    const totalSgst = this.round(
      lineItems.reduce((sum, item) => sum + item.sgstAmount, 0),
    );
    const totalIgst = this.round(
      lineItems.reduce((sum, item) => sum + item.igstAmount, 0),
    );
    const totalTax = this.round(totalCgst + totalSgst + totalIgst);
    const grandTotal = this.round(subtotal + totalTax + shipping);

    return {
      subtotal,
      totalCgst,
      totalSgst,
      totalIgst,
      totalTax,
      totalDiscount,
      grandTotal,
    };
  }

  /**
   * Get the Indian financial year (1 April – 31 March) for a given instant,
   * as observed in the merchant's timezone.
   *
   * `timeZone` is required because servers run UTC: without it, a sale at
   * 00:30 IST on 1 April is 2025-03-31T19:00Z and gets filed into the PREVIOUS
   * financial year — consuming a serial from a year that may already be filed.
   * Pass `Organization.timezone`.
   *
   * Examples (Asia/Kolkata):
   *   2026-03-31T19:00Z (00:30 IST, 1 Apr) → "2026-27"
   *   2026-03-31T17:00Z (22:30 IST, 31 Mar) → "2025-26"
   */
  getFinancialYear(date: Date, timeZone: string): string {
    return getFinancialYear(date, timeZone);
  }

  /**
   * Round to 2 decimal places (standard for currency).
   *
   * Public so callers stop redeclaring `const round = (n) => Math.round(n*100)/100`
   * locally — that helper had four independent copies across order, draft-order
   * and invoice services, which meant any change to rounding policy had to find
   * all of them.
   */
  round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private round(value: number): number {
    return this.round2(value);
  }

  /**
   * Convert Prisma Decimal to number for calculations.
   * Null/undefined collapse to 0 — use `toNullableNumber` when the difference
   * between "not configured" and "explicitly zero" matters.
   */
  toNumber(decimal: Decimal | number | null | undefined): number {
    if (decimal === null || decimal === undefined) return 0;
    if (typeof decimal === 'number') return decimal;
    return parseFloat(decimal.toString());
  }

  /**
   * Convert Prisma Decimal to number, PRESERVING null.
   *
   * Required for GST rates: `toNumber` maps both `null` and `Decimal(0.00)` to
   * `0`, which destroyed the distinction between "no rate configured" (fall
   * through to collection/product-type/state rates) and "explicitly exempt at
   * 0%" (stop here). Callers resolving a product's GST rate must use this.
   */
  toNullableNumber(
    decimal: Decimal | number | null | undefined,
  ): number | null {
    if (decimal === null || decimal === undefined) return null;
    if (typeof decimal === 'number') return decimal;
    return parseFloat(decimal.toString());
  }
}
