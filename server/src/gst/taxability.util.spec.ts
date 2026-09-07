import { GstSupplyType } from '@prisma/client';
import { isLineTaxable } from './taxability.util';

/**
 * Getting this backwards has two failure modes, both bad and neither loud:
 * treat an exempt line as taxable and the customer is overcharged on a
 * statutory invoice; treat a taxable line as exempt and output tax is
 * under-declared to the government.
 */
describe('isLineTaxable', () => {
  it('exempts the line when either flag says false', () => {
    expect(isLineTaxable({ lineTaxable: false, variantTaxable: true })).toBe(false);
    expect(isLineTaxable({ lineTaxable: true, variantTaxable: false })).toBe(false);
    expect(isLineTaxable({ lineTaxable: false, variantTaxable: false })).toBe(false);
  });

  it('taxes the line when both flags say true', () => {
    expect(isLineTaxable({ lineTaxable: true, variantTaxable: true })).toBe(true);
  });

  it('treats missing information as taxable, matching the column default', () => {
    // A Shopify line whose variant relation did not resolve must NOT be
    // silently exempted — that would turn a data-loading gap into an
    // under-declaration nobody would notice.
    expect(isLineTaxable({})).toBe(true);
    expect(isLineTaxable({ lineTaxable: null, variantTaxable: undefined })).toBe(true);
    expect(isLineTaxable({ variantTaxable: true })).toBe(true);
  });
});

describe('isLineTaxable — statutory classification', () => {
  // An export is ZERO_RATED from its place of supply, but that fact never
  // reached rate resolution, so the chain handed it the goods' ordinary rate.
  // Live consequence: INV-26-27/000007 was raised with ₹266.38 of IGST on a
  // supply the sales channel had charged nothing for, so the invoice total
  // exceeded the order it billed. Under an LUT an export is zero-rated
  // WITHOUT payment of tax.
  it('treats a zero-rated export as attracting no tax', () => {
    expect(isLineTaxable({ supplyType: GstSupplyType.ZERO_RATED })).toBe(false);
  });

  it.each([
    GstSupplyType.NIL_RATED,
    GstSupplyType.EXEMPT,
    GstSupplyType.NON_GST,
  ])('treats %s as attracting no tax', (supplyType) => {
    expect(isLineTaxable({ supplyType })).toBe(false);
  });

  it('leaves a TAXABLE supply to the rate chain', () => {
    expect(isLineTaxable({ supplyType: GstSupplyType.TAXABLE })).toBe(true);
  });

  it('stays taxable when the caller does not classify', () => {
    // Absent means "not classified" — the taxable flags remain the only
    // signal, which is how every caller behaved before this was threaded in.
    expect(isLineTaxable({})).toBe(true);
    expect(isLineTaxable({ supplyType: null })).toBe(true);
  });

  it('still honours an explicit non-taxable flag on a TAXABLE supply', () => {
    expect(
      isLineTaxable({ supplyType: GstSupplyType.TAXABLE, lineTaxable: false }),
    ).toBe(false);
    expect(
      isLineTaxable({ supplyType: GstSupplyType.TAXABLE, variantTaxable: false }),
    ).toBe(false);
  });
});
