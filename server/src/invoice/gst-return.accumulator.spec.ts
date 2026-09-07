import { GstSupplyType, GstType, InvoiceStatus } from '@prisma/client';
import {
  Gstr1Accumulator,
  Gstr3bAccumulator,
  type ReturnInvoice,
  type ReturnLineItem,
} from './gst-return.accumulator';

/**
 * These accumulators produce the numbers a merchant files with the government.
 *
 * If the B2B/B2C split is wrong, invoices land in the wrong GSTR-1 table and
 * the portal rejects the return. If table 3.2 includes registered buyers, the
 * merchant declares more inter-state B2C supply than they made. If the money
 * accumulates in floating point, the declared total drifts from the sum of the
 * invoices it claims to represent — by a few paise on a small period, and
 * without bound as volume grows.
 *
 * Every expected value below is computed by hand, never read back from the
 * implementation.
 */

function line(overrides: Partial<ReturnLineItem> = {}): ReturnLineItem {
  return {
    hsnCode: '6109',
    unitOfMeasure: 'NOS',
    supplyType: GstSupplyType.TAXABLE,
    description: 'Cotton Shirt',
    quantity: 1,
    taxableValue: '1000.00',
    gstRate: '18.00',
    cgstAmount: '0.00',
    sgstAmount: '0.00',
    igstAmount: '180.00',
    totalTax: '180.00',
    ...overrides,
  };
}

function invoice(overrides: Partial<ReturnInvoice> = {}): ReturnInvoice {
  return {
    status: InvoiceStatus.ISSUED,
    invoiceNumber: 'INV-2025-26/000001',
    invoiceDate: new Date('2025-04-10T00:00:00.000Z'),
    buyerGstin: null,
    buyerName: 'Guest Customer',
    placeOfSupply: '29',
    placeOfSupplyName: 'Karnataka',
    gstType: GstType.IGST,
    subtotal: '1000.00',
    totalCgst: '0.00',
    totalSgst: '0.00',
    totalIgst: '180.00',
    totalTax: '180.00',
    grandTotal: '1180.00',
    lineItems: [line()],
    ...overrides,
  };
}

describe('Gstr1Accumulator', () => {
  it('splits B2B from B2C on the presence of a buyer GSTIN', () => {
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(invoice({ buyerGstin: '29AABCU9603R1ZM', buyerName: 'Acme' }));
    acc.addInvoice(invoice({ buyerGstin: null }));

    const out = acc.finish();

    expect(out.b2b).toHaveLength(1);
    expect(out.b2b[0].buyerGstin).toBe('29AABCU9603R1ZM');
    expect(out.b2cSummary).toHaveLength(1);
    expect(out.totals.totalInvoices).toBe(2);
  });

  it('groups several invoices for one buyer, keeping them invoice-wise', () => {
    // GSTR-1 table 4A is invoice-wise by statute — the group must not collapse
    // its invoices into a single summed row.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({
        buyerGstin: '29AABCU9603R1ZM',
        invoiceNumber: 'INV-2025-26/000001',
        subtotal: '1000.00',
        totalTax: '180.00',
      }),
    );
    acc.addInvoice(
      invoice({
        buyerGstin: '29AABCU9603R1ZM',
        invoiceNumber: 'INV-2025-26/000002',
        subtotal: '2000.00',
        totalTax: '360.00',
      }),
    );

    const [group] = acc.finish().b2b;

    expect(group.invoiceCount).toBe(2);
    expect(group.invoices.map((i) => i.invoiceNumber)).toEqual([
      'INV-2025-26/000001',
      'INV-2025-26/000002',
    ]);
    // 1000 + 2000, 180 + 360
    expect(group.totalTaxable).toBe(3000);
    expect(group.totalTax).toBe(540);
  });

  it('carries place of supply on each B2B invoice, not on the buyer group', () => {
    // One buyer can be supplied in several states; place of supply is a
    // mandatory GSTR-1 field, so it has to travel per invoice.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({ buyerGstin: '29AABCU9603R1ZM', placeOfSupply: '29' }),
    );
    acc.addInvoice(
      invoice({ buyerGstin: '29AABCU9603R1ZM', placeOfSupply: '27' }),
    );

    const [group] = acc.finish().b2b;

    expect(group.invoices.map((i) => i.placeOfSupply)).toEqual(['29', '27']);
  });

  it('groups a B2C invoice with no place of supply under 00, never "null"', () => {
    // The exporter used to interpolate the raw key, so this rendered as the
    // literal string "null - null" in a return about to be filed.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({ placeOfSupply: null, placeOfSupplyName: null }),
    );

    const [row] = acc.finish().b2cSummary;

    expect(row.placeOfSupply).toBe('00');
    expect(row.placeOfSupplyName).toBe('Unspecified');
  });

  it('rolls line items into the HSN summary across invoices', () => {
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({
        lineItems: [
          line({ hsnCode: '6109', quantity: 2, taxableValue: '1000.00', igstAmount: '180.00', totalTax: '180.00' }),
          line({ hsnCode: '6203', quantity: 1, taxableValue: '500.00', igstAmount: '90.00', totalTax: '90.00' }),
        ],
      }),
    );
    acc.addInvoice(
      invoice({
        lineItems: [
          line({ hsnCode: '6109', quantity: 3, taxableValue: '1500.00', igstAmount: '270.00', totalTax: '270.00' }),
        ],
      }),
    );

    const hsn = acc.finish().hsnSummary;
    const shirts = hsn.find((h) => h.hsnCode === '6109')!;

    expect(shirts.quantity).toBe(5); // 2 + 3
    expect(shirts.taxableValue).toBe(2500); // 1000 + 1500
    expect(shirts.igst).toBe(450); // 180 + 270
    // Total value is taxable + tax, which Table 12 asks for as its own column.
    expect(shirts.totalValue).toBe(2950);
    expect(hsn.find((h) => h.hsnCode === '6203')!.quantity).toBe(1);
  });

  it('does not drift when summing many small amounts', () => {
    // The previous implementation summed `parseFloat` values and rounded once
    // at the very end. 0.1 + 0.2 !== 0.3 in binary floating point, and the
    // error compounds across every invoice in the period.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    for (let i = 0; i < 1000; i += 1) {
      acc.addInvoice(
        invoice({
          subtotal: '0.10',
          totalIgst: '0.20',
          totalTax: '0.20',
          lineItems: [],
        }),
      );
    }

    const { totals } = acc.finish();

    // 1000 × 0.10 and 1000 × 0.20, exactly.
    expect(totals.totalTaxable).toBe(100);
    expect(totals.totalIgst).toBe(200);
  });

  it('produces the same result regardless of the order invoices arrive in', () => {
    // Invoices arrive page by page in id order, which is unrelated to anything
    // statutory — the fold must be order-independent.
    const invoices = [
      invoice({ invoiceNumber: 'A', buyerGstin: '29AABCU9603R1ZM', subtotal: '100.00' }),
      invoice({ invoiceNumber: 'B', subtotal: '200.00', placeOfSupply: '27' }),
      invoice({ invoiceNumber: 'C', subtotal: '300.00', placeOfSupply: '29' }),
    ];

    const forward = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    invoices.forEach((i) => forward.addInvoice(i));

    const reverse = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    [...invoices].reverse().forEach((i) => reverse.addInvoice(i));

    expect(forward.finish().totals).toEqual(reverse.finish().totals);
  });
});

describe('Gstr3bAccumulator', () => {
  it('buckets line items by GST rate, sorted ascending', () => {
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(
      invoice({
        lineItems: [
          line({ gstRate: '18.00', taxableValue: '1000.00', igstAmount: '180.00' }),
          line({ gstRate: '5.00', taxableValue: '400.00', igstAmount: '20.00' }),
          line({ gstRate: '18.00', taxableValue: '2000.00', igstAmount: '360.00' }),
        ],
      }),
    );

    const { outwardSupplies } = acc.finish();

    expect(outwardSupplies.map((r) => r.gstRate)).toEqual([5, 18]);
    // 1000 + 2000 at 18%, 180 + 360 IGST
    expect(outwardSupplies[1].taxableValue).toBe(3000);
    expect(outwardSupplies[1].igst).toBe(540);
    expect(outwardSupplies[1].totalTax).toBe(540);
  });

  it('reports a zero-rated export in 3.1(b) only, never also in 3.1(a)', () => {
    // 3.1(a) is defined as "outward taxable supplies (OTHER THAN zero-rated,
    // nil-rated and exempted)", so (b), (c) and (e) are alternatives to it.
    // The classifying switch used to fall through into the rate buckets, so an
    // export was declared twice — at 18% in (a) and again as zero-rated in (b)
    // — overstating outward supplies by its full value. On the live data that
    // was ₹1,479.90 counted twice out of a ₹6,374.22 return.
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(
      invoice({
        gstType: GstType.IGST,
        placeOfSupply: '96',
        placeOfSupplyName: 'Other Country',
        subtotal: '1000.00',
        totalIgst: '0.00',
        totalTax: '0.00',
        lineItems: [
          line({
            supplyType: GstSupplyType.ZERO_RATED,
            taxableValue: '1000.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
        ],
      }),
    );

    const out = acc.finish();

    expect(out.otherSupplies.zeroRated).toBe(1000);
    // Nothing in (a) at all — not a 0% row, not an 18% row.
    expect(out.outwardSupplies).toHaveLength(0);
    // 3.2 is a memo OF 3.1(a); a supply absent from the parent cannot appear
    // in the memo.
    expect(out.interState.byState).toHaveLength(0);
    expect(out.interState.totalTaxable).toBe(0);
  });

  it('keeps the taxable part of a mixed invoice in 3.1(a) and only the rest in (b)', () => {
    // A part-export invoice must split, not land wholly in one row.
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(
      invoice({
        gstType: GstType.IGST,
        subtotal: '1500.00',
        totalIgst: '90.00',
        totalTax: '90.00',
        lineItems: [
          line({ taxableValue: '500.00', gstRate: '18.00', igstAmount: '90.00', totalTax: '90.00' }),
          line({
            supplyType: GstSupplyType.ZERO_RATED,
            taxableValue: '1000.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
        ],
      }),
    );

    const out = acc.finish();

    expect(out.otherSupplies.zeroRated).toBe(1000);
    expect(out.outwardSupplies).toHaveLength(1);
    expect(out.outwardSupplies[0].gstRate).toBe(18);
    expect(out.outwardSupplies[0].taxableValue).toBe(500);
    // The memo carries the 3.1(a) portion only, not the whole subtotal.
    expect(out.interState.totalTaxable).toBe(500);
  });

  it('excludes registered buyers from table 3.2 but keeps them in the aggregate', () => {
    // This is the distinction the CSV exporter used to lose: 3.2 is inter-state
    // supplies to UNREGISTERED persons, while the sibling aggregate spans every
    // inter-state invoice. Writing the aggregate into the 3.2 row overstated it.
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(
      invoice({
        buyerGstin: '29AABCU9603R1ZM',
        gstType: GstType.IGST,
        placeOfSupply: '29',
        subtotal: '5000.00',
        totalIgst: '900.00',
        // Table 3.2 is a memo of 3.1(a) and is now built from the same lines
        // that feed it, so a fixture's lines have to agree with its subtotal.
        // Overriding only the subtotal described an invoice that cannot exist.
        lineItems: [
          line({ taxableValue: '5000.00', igstAmount: '900.00', totalTax: '900.00' }),
        ],
      }),
    );
    acc.addInvoice(
      invoice({
        buyerGstin: null,
        gstType: GstType.IGST,
        placeOfSupply: '29',
        subtotal: '1000.00',
        totalIgst: '180.00',
      }),
    );

    const { interState } = acc.finish();

    // Aggregate: both invoices.
    expect(interState.invoiceCount).toBe(2);
    expect(interState.totalTaxable).toBe(6000);
    expect(interState.totalIgst).toBe(1080);

    // 3.2: only the unregistered one.
    expect(interState.byState).toHaveLength(1);
    expect(interState.byState[0].placeOfSupply).toBe('29');
    expect(interState.byState[0].invoiceCount).toBe(1);
    expect(interState.byState[0].totalIgst).toBe(180);

    // The two must never be treated as interchangeable.
    const byStateIgst = interState.byState.reduce(
      (sum, s) => sum + s.totalIgst,
      0,
    );
    expect(byStateIgst).toBeLessThan(interState.totalIgst);
  });

  it('keeps intra-state invoices out of the inter-state section entirely', () => {
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(
      invoice({
        gstType: GstType.CGST_SGST,
        totalCgst: '90.00',
        totalSgst: '90.00',
        totalIgst: '0.00',
        totalTax: '180.00',
      }),
    );

    const { interState, taxPayable } = acc.finish();

    expect(interState.invoiceCount).toBe(0);
    expect(interState.byState).toHaveLength(0);
    // ...but it still contributes to tax payable.
    expect(taxPayable.cgst).toBe(90);
    expect(taxPayable.sgst).toBe(90);
    expect(taxPayable.total).toBe(180);
  });

  it('sums tax payable across every invoice in the period', () => {
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(
      invoice({ totalCgst: '45.00', totalSgst: '45.00', totalIgst: '0.00', totalTax: '90.00' }),
    );
    acc.addInvoice(
      invoice({ totalCgst: '0.00', totalSgst: '0.00', totalIgst: '180.00', totalTax: '180.00' }),
    );

    const { taxPayable } = acc.finish();

    expect(taxPayable.cgst).toBe(45);
    expect(taxPayable.sgst).toBe(45);
    expect(taxPayable.igst).toBe(180);
    expect(taxPayable.total).toBe(270);
  });
});

/**
 * Phase 2 tables.
 *
 * The defect these replace: every B2C invoice was summarised into ONE row per
 * place of supply, mixing every rate together. GSTR-1 has no such row — Table 5
 * is invoice-wise above a threshold and Table 7 is rate-wise, and a state row
 * spanning 5% and 18% cannot be filed at all.
 */
describe('Gstr1Accumulator — B2CL / B2CS split', () => {
  const interStateB2c = (grandTotal: string, taxable: string, igst: string) =>
    invoice({
      buyerGstin: null,
      gstType: GstType.IGST,
      placeOfSupply: '24',
      placeOfSupplyName: 'Gujarat',
      subtotal: taxable,
      totalIgst: igst,
      totalTax: igst,
      grandTotal,
      lineItems: [
        line({
          taxableValue: taxable,
          gstRate: '18.00',
          igstAmount: igst,
          totalTax: igst,
        }),
      ],
    });

  it('reports an inter-state B2C invoice ABOVE the threshold in Table 5', () => {
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(interStateB2c('118000.00', '100000.00', '18000.00'));

    const out = acc.finish();

    expect(out.b2cl).toHaveLength(1);
    expect(out.b2cl[0].gstRate).toBe(18);
    expect(out.b2cl[0].taxableValue).toBe(100000);
    expect(out.b2cl[0].igst).toBe(18000);
    expect(out.b2cl[0].placeOfSupplyName).toBe('Gujarat');
    // It must not ALSO appear in the summarised table.
    expect(out.b2cs).toHaveLength(0);
  });

  it('is decided on invoice VALUE, not taxable value', () => {
    // Taxable 99,000 but invoice value 1,16,820 — the statute speaks in invoice
    // value, so this is B2CL even though the taxable base is under the limit.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(interStateB2c('116820.00', '99000.00', '17820.00'));

    expect(acc.finish().b2cl).toHaveLength(1);
  });

  it('treats an invoice exactly AT the threshold as B2CS, not B2CL', () => {
    // "Above" is strictly greater — an invoice of exactly the threshold is not
    // a large invoice, and an off-by-one here misfiles a real invoice.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(interStateB2c('100000.00', '84745.76', '15254.24'));

    const out = acc.finish();

    expect(out.b2cl).toHaveLength(0);
    expect(out.b2cs).toHaveLength(1);
  });

  it('never puts an INTRA-state invoice in Table 5, however large', () => {
    // B2CL is inter-state only. A large local sale is summarised.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({
        buyerGstin: null,
        gstType: GstType.CGST_SGST,
        placeOfSupply: '27',
        subtotal: '500000.00',
        totalCgst: '45000.00',
        totalSgst: '45000.00',
        totalIgst: '0.00',
        totalTax: '90000.00',
        grandTotal: '590000.00',
        lineItems: [
          line({
            taxableValue: '500000.00',
            gstRate: '18.00',
            cgstAmount: '45000.00',
            sgstAmount: '45000.00',
            igstAmount: '0.00',
            totalTax: '90000.00',
          }),
        ],
      }),
    );

    const out = acc.finish();

    expect(out.b2cl).toHaveLength(0);
    expect(out.b2cs[0].supplyType).toBe('INTRA');
  });

  it('splits one B2C invoice into a row PER RATE', () => {
    // This is the whole point of Table 7. The old single-row-per-state shape
    // merged these and was unfilable.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({
        buyerGstin: null,
        gstType: GstType.CGST_SGST,
        placeOfSupply: '27',
        subtotal: '1400.00',
        totalCgst: '100.00',
        totalSgst: '100.00',
        totalIgst: '0.00',
        totalTax: '200.00',
        grandTotal: '1600.00',
        lineItems: [
          // 1000 at 18% gives 90 + 90
          line({
            gstRate: '18.00',
            taxableValue: '1000.00',
            cgstAmount: '90.00',
            sgstAmount: '90.00',
            igstAmount: '0.00',
            totalTax: '180.00',
          }),
          // 400 at 5% gives 10 + 10
          line({
            gstRate: '5.00',
            taxableValue: '400.00',
            cgstAmount: '10.00',
            sgstAmount: '10.00',
            igstAmount: '0.00',
            totalTax: '20.00',
          }),
        ],
      }),
    );

    const out = acc.finish();

    expect(out.b2cs).toHaveLength(2);
    expect(out.b2cs.map((r) => r.gstRate)).toEqual([5, 18]);
    expect(out.b2cs.find((r) => r.gstRate === 18)!.taxableValue).toBe(1000);
    expect(out.b2cs.find((r) => r.gstRate === 5)!.cgst).toBe(10);

    // The rate-wise rows must still add up to the per-state roll-up.
    const b2csTaxable = out.b2cs.reduce((s, r) => s + r.taxableValue, 0);
    expect(b2csTaxable).toBe(out.b2cSummary[0].totalTaxable);
  });
});

describe('Gstr1Accumulator — Table 12 and Table 8', () => {
  it('splits ONE HSN code across two rate rows', () => {
    // Table 12 is keyed by HSN and rate. Merging them produced a row whose tax
    // could not be derived from its taxable value.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({
        lineItems: [
          line({
            hsnCode: '6109',
            gstRate: '5.00',
            taxableValue: '400.00',
            igstAmount: '20.00',
            totalTax: '20.00',
          }),
          line({
            hsnCode: '6109',
            gstRate: '18.00',
            taxableValue: '1000.00',
            igstAmount: '180.00',
            totalTax: '180.00',
          }),
        ],
      }),
    );

    const hsn = acc.finish().hsnSummary.filter((h) => h.hsnCode === '6109');

    expect(hsn).toHaveLength(2);
    expect(hsn.map((h) => h.gstRate)).toEqual([5, 18]);
    expect(hsn.find((h) => h.gstRate === 5)!.igst).toBe(20);
  });

  /**
   * Table 12 asks the filer to describe the goods behind each HSN code.
   *
   * The column used to hold whichever line was folded FIRST and discard the
   * rest, so an HSN covering several products was labelled with one arbitrary
   * name — on real data, a 120-rupee test product standing in for 4,748 of
   * snowboards — and which name won depended on the invoice-id sort order.
   * That is a wrong description on a document filed with the tax department.
   */
  describe('Table 12 description', () => {
    const snowboards = () => [
      line({ hsnCode: '9506', description: 'tEST 2', taxableValue: '120.00' }),
      line({
        hsnCode: '9506',
        description: 'The Collection Snowboard: Liquid',
        taxableValue: '749.95',
      }),
      line({
        hsnCode: '9506',
        description: 'The Multi-managed Snowboard',
        taxableValue: '629.95',
      }),
      line({
        hsnCode: '9506',
        description: 'The 3p Fulfilled Snowboard',
        taxableValue: '2524.47',
      }),
    ];

    function describeOf(lineItems: ReturnLineItem[], hsnCode = '9506'): string {
      const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
      acc.addInvoice(invoice({ lineItems }));
      return acc.finish().hsnSummary.find((h) => h.hsnCode === hsnCode)!
        .description;
    }

    it('names the product carrying the most value, not the first one folded', () => {
      // 2,524.47 of "The 3p Fulfilled Snowboard" against 120.00 of "tEST 2",
      // which is folded first and used to win outright.
      expect(describeOf(snowboards())).toBe(
        'The 3p Fulfilled Snowboard +3 more',
      );
    });

    it('does not change with fold order', () => {
      // The old behaviour was order-dependent, so an unrelated data change
      // could silently re-describe a period.
      expect(describeOf([...snowboards()].reverse())).toBe(
        'The 3p Fulfilled Snowboard +3 more',
      );
    });

    it('adds no suffix when the row really is one product', () => {
      expect(
        describeOf([
          line({ hsnCode: '9506', description: 'The Complete Snowboard', taxableValue: '699.95' }),
          line({ hsnCode: '9506', description: 'The Complete Snowboard', taxableValue: '699.95' }),
        ]),
      ).toBe('The Complete Snowboard');
    });

    it('lets a product split across lines outweigh one larger line', () => {
      // 3 x 400 = 1,200 of shirts beats a single 1,000 trouser line. Picking
      // per-line maxima instead of accumulated value would get this backwards.
      expect(
        describeOf([
          line({ hsnCode: '6109', description: 'Cotton Shirt', taxableValue: '400.00' }),
          line({ hsnCode: '6109', description: 'Cotton Shirt', taxableValue: '400.00' }),
          line({ hsnCode: '6109', description: 'Cotton Shirt', taxableValue: '400.00' }),
          line({ hsnCode: '6109', description: 'Wool Trousers', taxableValue: '1000.00' }),
        ], '6109'),
      ).toBe('Cotton Shirt +1 more');
    });

    it('skips blank descriptions rather than letting one win the row', () => {
      expect(
        describeOf([
          line({ hsnCode: '9506', description: '   ', taxableValue: '5000.00' }),
          line({ hsnCode: '9506', description: 'The Complete Snowboard', taxableValue: '10.00' }),
        ]),
      ).toBe('The Complete Snowboard');
    });

    it('falls back to an empty string when no line carries a description', () => {
      expect(
        describeOf([
          line({ hsnCode: '9506', description: '', taxableValue: '100.00' }),
          line({ hsnCode: '9506', description: '   ', taxableValue: '200.00' }),
        ]),
      ).toBe('');
    });

    it('breaks a value tie on the name, so the output is stable', () => {
      expect(
        describeOf([
          line({ hsnCode: '9506', description: 'Beta Board', taxableValue: '500.00' }),
          line({ hsnCode: '9506', description: 'Alpha Board', taxableValue: '500.00' }),
        ]),
      ).toBe('Alpha Board +1 more');
    });

    it('stops claiming a count once the per-row cap is passed', () => {
      // The cap keeps this class at O(distinct HSN) memory over a 50,000-invoice
      // period. Past it we no longer know how many DISTINCT products were
      // dropped, only that some were — so the suffix must stop printing a
      // number rather than print one that counts repeats.
      const many = Array.from({ length: 100 }, (_, i) =>
        line({
          hsnCode: '9506',
          description: `Board ${String(i).padStart(3, '0')}`,
          taxableValue: '10.00',
          igstAmount: '1.80',
          totalTax: '1.80',
        }),
      );
      // One dominant line so the winner is not itself a tie.
      many.push(
        line({
          hsnCode: '9506',
          description: 'Flagship Board',
          taxableValue: '9999.00',
          igstAmount: '1799.82',
          totalTax: '1799.82',
        }),
      );

      const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
      acc.addInvoice(invoice({ lineItems: many }));
      const rows = acc.finish().hsnSummary.filter((h) => h.hsnCode === '9506');

      // Still ONE row, and the money is unaffected by the cap.
      expect(rows).toHaveLength(1);
      expect(rows[0].taxableValue).toBe(10999); // 100 x 10 + 9,999
      expect(rows[0].quantity).toBe(101);
      expect(rows[0].description).toBe('Flagship Board and others');
    });
  });

  it('carries a UQC on every row and counts unclassified lines', () => {
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({
        lineItems: [
          line({ hsnCode: '6109', unitOfMeasure: 'PCS' }),
          // Both a null and the legacy placeholder mean "not classified".
          line({ hsnCode: null, unitOfMeasure: null }),
          line({ hsnCode: '0000' }),
        ],
      }),
    );

    const out = acc.finish();

    expect(out.hsnSummary.find((h) => h.hsnCode === '6109')!.uqc).toBe('PCS');
    // Missing UQC falls back rather than emitting an invalid blank.
    expect(out.hsnSummary.find((h) => h.hsnCode === null)!.uqc).toBe('NOS');
    // The placeholder is never surfaced as if it were a real code.
    expect(out.hsnSummary.some((h) => h.hsnCode === '0000')).toBe(false);
    expect(out.totals.linesMissingHsn).toBe(2);
  });

  it('keys HSN rows by recipient type, so the B2B and B2C tabs never merge', () => {
    // The portal has reported Table 12 as two tabs since the May-2025 period,
    // each reconciling to its own supplies. The same product sold to a
    // registered and an unregistered buyer is therefore two rows, not one.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({ buyerGstin: '29AABCU9603R1ZM', buyerName: 'Acme' }),
    );
    acc.addInvoice(invoice({ buyerGstin: null }));

    const rows = acc.finish().hsnSummary.filter((h) => h.hsnCode === '6109');

    expect(rows).toHaveLength(2);
    // B2B sorts first, so a reader sees the registered side of the table first.
    expect(rows.map((r) => r.recipientType)).toEqual(['B2B', 'B2C']);
    // Neither row absorbed the other's value.
    expect(rows[0].taxableValue).toBe(1000);
    expect(rows[1].taxableValue).toBe(1000);
  });

  it('splits nil-rated, exempt and non-GST into Table 8, by buyer and border', () => {
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({
        buyerGstin: null,
        gstType: GstType.IGST,
        lineItems: [
          line({
            supplyType: GstSupplyType.NIL_RATED,
            taxableValue: '100.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
          line({
            supplyType: GstSupplyType.EXEMPT,
            taxableValue: '200.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
          line({
            supplyType: GstSupplyType.NON_GST,
            taxableValue: '300.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
          // A taxable line must not leak into Table 8.
          line({ supplyType: GstSupplyType.TAXABLE, taxableValue: '1000.00' }),
        ],
      }),
    );

    const rows = acc.finish().nilRated;

    // Unregistered buyer, inter-state, so section 8C.
    expect(rows).toHaveLength(1);
    expect(rows[0].section).toBe('8C');
    expect(rows[0].nilRated).toBe(100);
    expect(rows[0].exempted).toBe(200);
    expect(rows[0].nonGst).toBe(300);
  });

  it('omits Table 8 rows entirely when there is nothing to report', () => {
    // Four permanently-zero rows would read as filed figures.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(invoice());

    expect(acc.finish().nilRated).toHaveLength(0);
  });

  it('keeps a zero-rated export OUT of Table 8', () => {
    // An export belongs in GSTR-3B 3.1(b), not among nil-rated supplies.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(
      invoice({
        placeOfSupply: '96',
        lineItems: [
          line({
            supplyType: GstSupplyType.ZERO_RATED,
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
        ],
      }),
    );

    expect(acc.finish().nilRated).toHaveLength(0);
  });
});

describe('Gstr3bAccumulator — 3.1(b)(c)(e)', () => {
  it('separates zero-rated, nil/exempt and non-GST supplies', () => {
    // Before Phase 2 every line landed in 3.1(a) and these three were
    // permanently empty — which the panel admitted to the user in its own copy.
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(
      invoice({
        lineItems: [
          line({
            supplyType: GstSupplyType.ZERO_RATED,
            taxableValue: '5000.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
          line({
            supplyType: GstSupplyType.NIL_RATED,
            taxableValue: '100.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
          line({
            supplyType: GstSupplyType.EXEMPT,
            taxableValue: '200.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
          line({
            supplyType: GstSupplyType.NON_GST,
            taxableValue: '300.00',
            gstRate: '0.00',
            igstAmount: '0.00',
            totalTax: '0.00',
          }),
        ],
      }),
    );

    const { otherSupplies } = acc.finish();

    expect(otherSupplies.zeroRated).toBe(5000);
    // Nil-rated and exempt share one line on the form.
    expect(otherSupplies.nilRatedExempt).toBe(300); // 100 + 200
    expect(otherSupplies.nonGst).toBe(300);
  });
});

/**
 * Credit notes.
 *
 * THE DEFECT THIS CLOSES: a refunded sale stayed 100% in declared output
 * liability for ever. Refunds carried no tax at all, `InvoiceStatus.CREDIT_NOTE`
 * was dead code, and GSTR-1 had no Table 9B — so any merchant who accepts
 * returns has been over-declaring tax every month.
 *
 * Amounts are stored POSITIVE, as they appear on the paper document. The fold
 * subtracts them. Storing negatives would double-negate the moment anything
 * else summed the column.
 */
describe('Gstr3bAccumulator — outward reverse charge', () => {
  const rcmInvoice = (over = {}) =>
    invoice({
      reverseCharge: true,
      buyerGstin: '29AABCU9603R1ZM',
      buyerName: 'Acme',
      ...over,
    });

  it('keeps a reverse-charge supply out of 3.1(a), 3.2 and tax payable', () => {
    // The portal builds 3.1(a) from GSTR-1 tables that EXCLUDE 4B: the
    // supplier owes nothing, and the recipient declares the same tax in their
    // own 3.1(d). Leaving it here would declare one tax twice and ask this
    // merchant to pay what the law puts on someone else.
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(rcmInvoice());

    const out = acc.finish();

    expect(out.outwardSupplies).toEqual([]);
    expect(out.taxPayable.total).toBe(0);
    expect(out.interState.invoiceCount).toBe(0);
    expect(out.outwardReverseCharge).toMatchObject({
      invoiceCount: 1,
      taxableValue: 1000,
      tax: 180,
    });
  });

  it('leaves an ordinary invoice in 3.1(a) alongside it', () => {
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(rcmInvoice());
    acc.addInvoice(invoice());

    const out = acc.finish();

    expect(out.outwardSupplies).toHaveLength(1);
    expect(out.outwardSupplies[0].taxableValue).toBe(1000);
    expect(out.taxPayable.igst).toBe(180);
    expect(out.outwardReverseCharge!.taxableValue).toBe(1000);
  });

  it('still reports an exempt line on a reverse-charge invoice in 3.1(c)', () => {
    // A nil-rated or exempt line carries no tax for anyone, so who would have
    // paid it does not change where it is reported. Only the taxable component
    // moves out of 3.1(a).
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(
      rcmInvoice({
        lineItems: [
          line({ supplyType: GstSupplyType.EXEMPT, taxableValue: '500.00', igstAmount: '0.00', totalTax: '0.00' }),
          line(),
        ],
      }),
    );

    const out = acc.finish();

    expect(out.otherSupplies.nilRatedExempt).toBe(500);
    // Only the taxable line moved to the reverse-charge bucket.
    expect(out.outwardReverseCharge!.taxableValue).toBe(1000);
    expect(out.outwardSupplies).toEqual([]);
  });

  it('nets a credit note against the reverse-charge bucket, not tax payable', () => {
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(rcmInvoice());
    acc.addInvoice(rcmInvoice({ status: InvoiceStatus.CREDIT_NOTE }));

    const out = acc.finish();

    expect(out.outwardReverseCharge).toMatchObject({
      invoiceCount: 0,
      taxableValue: 0,
      tax: 0,
    });
    expect(out.taxPayable.total).toBe(0);
  });

  it('counts a reverse-charge invoice with no buyer GSTIN as suspect', () => {
    // Reverse charge on outward supplies runs B2B; an unregistered recipient
    // is almost certainly a mis-flag, so it is surfaced rather than guessed at.
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(rcmInvoice({ buyerGstin: null }));

    expect(acc.finish().outwardReverseCharge!.unregisteredRecipients).toBe(1);
  });
});

describe('Gstr1Accumulator — credit notes', () => {
  const creditNote = (overrides: Partial<ReturnInvoice> = {}) =>
    invoice({
      status: InvoiceStatus.CREDIT_NOTE,
      invoiceNumber: 'CN-2025-26/000001',
      creditNoteForNumber: 'INV-2025-26/000001',
      creditNoteReason: 'Goods returned',
      ...overrides,
    });

  it('reports a credit note in table 9B, never in 4A/5/7', () => {
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(invoice({ buyerGstin: '29AABCU9603R1ZM' }));
    acc.addInvoice(creditNote({ buyerGstin: '29AABCU9603R1ZM' }));

    const out = acc.finish();

    expect(out.creditNotes).toHaveLength(1);
    expect(out.creditNotes[0].noteNumber).toBe('CN-2025-26/000001');
    expect(out.creditNotes[0].originalInvoiceNumber).toBe('INV-2025-26/000001');
    expect(out.creditNotes[0].reason).toBe('Goods returned');
    // The buyer group must still show ONE invoice, not two.
    expect(out.b2b[0].invoiceCount).toBe(1);
    expect(out.totals.totalInvoices).toBe(1);
  });

  it('splits CDNR from CDNUR on whether the buyer is registered', () => {
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(creditNote({ buyerGstin: '29AABCU9603R1ZM' }));
    acc.addInvoice(creditNote({ invoiceNumber: 'CN-2', buyerGstin: null }));

    const sections = acc.finish().creditNotes.map((n) => n.section);

    expect(sections).toEqual(['CDNR', 'CDNUR']);
  });

  it('NETS the filed totals — this is the whole point', () => {
    // One 1,000 sale at 18%, fully credited. The merchant owes nothing, and
    // before this the return still declared the full 180.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(invoice());
    acc.addInvoice(creditNote());

    const { totals } = acc.finish();

    expect(totals.totalTaxable).toBe(0);
    expect(totals.totalIgst).toBe(0);
    expect(totals.totalTax).toBe(0);
    // ...while the gross figures stay visible, so the deduction is explicit.
    expect(totals.grossTaxable).toBe(1000);
    expect(totals.creditNoteCount).toBe(1);
    expect(totals.creditNoteTaxable).toBe(1000);
    expect(totals.creditNoteTax).toBe(180);
  });

  it('nets only partially for a partial credit', () => {
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(invoice());
    acc.addInvoice(
      creditNote({
        subtotal: '400.00',
        totalIgst: '72.00',
        totalTax: '72.00',
        grandTotal: '472.00',
      }),
    );

    const { totals } = acc.finish();

    expect(totals.totalTaxable).toBe(600); // 1000 - 400
    expect(totals.totalIgst).toBe(108); // 180 - 72
  });

  it('keeps credit-note lines out of table 12 and table 8', () => {
    // Table 12 reports invoice LINES. Adding a credit note's lines would
    // inflate the quantity and taxable value of the HSN it reverses.
    const acc = new Gstr1Accumulator({ b2cLargeThreshold: 100000 });
    acc.addInvoice(invoice());
    acc.addInvoice(creditNote());

    const out = acc.finish();

    expect(out.hsnSummary).toHaveLength(1);
    expect(out.hsnSummary[0].quantity).toBe(1);
    expect(out.totals.grossTaxable).toBe(1000);
  });
});

describe('Gstr3bAccumulator — credit notes', () => {
  it('nets 3.1(a) and tax payable, as the form requires', () => {
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(invoice());
    acc.addInvoice(
      invoice({
        status: InvoiceStatus.CREDIT_NOTE,
        invoiceNumber: 'CN-2025-26/000001',
        subtotal: '400.00',
        totalIgst: '72.00',
        totalTax: '72.00',
        lineItems: [
          line({
            taxableValue: '400.00',
            gstRate: '18.00',
            igstAmount: '72.00',
            totalTax: '72.00',
          }),
        ],
      }),
    );

    const out = acc.finish();

    // 1000 - 400 taxable at 18%, 180 - 72 IGST.
    expect(out.outwardSupplies[0].taxableValue).toBe(600);
    expect(out.outwardSupplies[0].igst).toBe(108);
    expect(out.taxPayable.igst).toBe(108);
    expect(out.taxPayable.total).toBe(108);
  });

  it('nets the 3.2 state breakdown too', () => {
    const acc = new Gstr3bAccumulator();
    acc.addInvoice(invoice({ buyerGstin: null, gstType: GstType.IGST }));
    acc.addInvoice(
      invoice({
        status: InvoiceStatus.CREDIT_NOTE,
        buyerGstin: null,
        gstType: GstType.IGST,
        subtotal: '400.00',
        totalIgst: '72.00',
        totalTax: '72.00',
        // Lines have to match the subtotal — 3.2 is now derived from them, so
        // a credit note that reverses 400 has to say so on its line too.
        lineItems: [
          line({ taxableValue: '400.00', igstAmount: '72.00', totalTax: '72.00' }),
        ],
      }),
    );

    const { interState } = acc.finish();

    // One invoice minus one credit note nets to zero documents, 600 taxable.
    expect(interState.byState[0].invoiceCount).toBe(0);
    expect(interState.byState[0].totalTaxable).toBe(600);
    expect(interState.byState[0].totalIgst).toBe(108);
  });
});
