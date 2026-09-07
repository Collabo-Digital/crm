import { GstType } from '@prisma/client';
import {
  buildGstr1Sections,
  buildGstr3bSections,
  renderCsvSections,
  GSTR3B_SECTION_INTERSTATE,
  GSTR3B_SECTION_OUTWARD,
  GSTR3B_SECTION_PAYABLE,
  GSTR3B_SECTION_RCM_ITC,
  type CsvSection,
} from './gst-return-rows';
import type { Gstr1Return, Gstr3bReturn } from './gst-return.accumulator';

/**
 * These sections ARE the filed artefact — the CSV a merchant downloads and
 * hands to their accountant.
 *
 * Two defects they replace. First, every table shared one fixed 12-column row,
 * so the HSN summary put its code in the `invoiceNumber` column and a quantity
 * string in `grandTotal` — and there was no free column left for the UQC and
 * rate that Table 12 legally requires. Second, GSTR-3B section 3.2 was written
 * as a sibling of 3.1 when it is a MEMO of it, so summing the tax column
 * double-counted.
 */

const gstr3b: Gstr3bReturn = {
  outwardSupplies: [
    { gstRate: 5, taxableValue: 400, cgst: 0, sgst: 0, igst: 20, totalTax: 20 },
    { gstRate: 18, taxableValue: 3000, cgst: 0, sgst: 0, igst: 540, totalTax: 540 },
  ],
  otherSupplies: { zeroRated: 5000, zeroRatedIgst: 0, nilRatedExempt: 300, nonGst: 120 },
  // A Shopify subscription: 1,000 of imported service, 180 of IGST self-paid
  // under reverse charge and reclaimed in the same period.
  reverseCharge: { taxableValue: 1000, igst: 180, entriesWithUnknownTax: 0 },
  interState: {
    invoiceCount: 3,
    totalTaxable: 3400,
    totalIgst: 560,
    byState: [
      {
        placeOfSupply: '29',
        placeOfSupplyName: 'Karnataka',
        invoiceCount: 1,
        totalTaxable: 1000,
        totalIgst: 180,
      },
      {
        placeOfSupply: '27',
        placeOfSupplyName: 'Maharashtra',
        invoiceCount: 1,
        totalTaxable: 400,
        totalIgst: 20,
      },
    ],
  },
  taxPayable: { cgst: 0, sgst: 0, igst: 560, total: 560 },
};

const find = (sections: CsvSection[], startsWith: string) =>
  sections.find((s) => s.title.startsWith(startsWith))!;

describe('buildGstr3bSections', () => {
  it('emits one labelled row per state for 3.2, not a single aggregate', () => {
    const section = find(buildGstr3bSections(gstr3b), '3.2');

    expect(section.rows).toHaveLength(2);
    expect(section.rows.map((r) => r[0])).toEqual([
      '29 - Karnataka',
      '27 - Maharashtra',
    ]);
  });

  it('names 3.2 as a memo so nobody sums it into the total', () => {
    // The aggregate spans every inter-state invoice INCLUDING B2B, while 3.2 is
    // unregistered-only, so the two are not interchangeable and 3.2's tax is
    // already inside 3.1.
    expect(GSTR3B_SECTION_INTERSTATE).toContain('3.2');
    expect(GSTR3B_SECTION_INTERSTATE).toContain('memo');
  });

  it('keeps 3.1 adding up to tax payable', () => {
    const sections = buildGstr3bSections(gstr3b);
    const outward = find(sections, '3.1(a)');
    const igstIndex = outward.headers.indexOf('IGST');

    const total = outward.rows.reduce((sum, r) => sum + Number(r[igstIndex]), 0);

    expect(total).toBe(560); // 20 + 540
    expect(total).toBe(gstr3b.taxPayable.igst);
  });

  it('reports zero-rated, nil/exempt and non-GST separately', () => {
    // Before Phase 2 nothing classified a supply, so these three were
    // permanently empty and the panel said so to the user.
    const section = find(buildGstr3bSections(gstr3b), '3.1(b)');

    // 3.1(b) also carries IGST — an export made without an LUT is zero-rated
    // but made on payment of tax. (c) and (e) never carry tax, so their cell is
    // blank rather than a zero that invites a total down the column.
    expect(section.rows).toEqual([
      ['(b) Zero-rated (exports / SEZ)', 5000, gstr3b.otherSupplies.zeroRatedIgst ?? 0],
      ['(c) Nil-rated and exempted', 300, ''],
      ['(e) Non-GST outward supplies', 120, ''],
    ]);
  });

  it('always emits tax payable, even for an empty period', () => {
    const sections = buildGstr3bSections({
      outwardSupplies: [],
      otherSupplies: { zeroRated: 0, zeroRatedIgst: 0, nilRatedExempt: 0, nonGst: 0 },
      interState: { invoiceCount: 0, totalTaxable: 0, totalIgst: 0, byState: [] },
      reverseCharge: { taxableValue: 0, igst: 0, entriesWithUnknownTax: 0 },
      taxPayable: { cgst: 0, sgst: 0, igst: 0, total: 0 },
    });

    expect(find(sections, '5.1').rows).toHaveLength(1);
    expect(GSTR3B_SECTION_PAYABLE).toContain('5.1');
    expect(GSTR3B_SECTION_OUTWARD).toContain('3.1(a)');
  });

  /**
   * Reverse charge is cash-neutral but DOUBLY declarable — the liability in
   * 3.1(d), the matching credit in 4(A)(3). Netting to nil is exactly why it
   * gets skipped, and skipping it is a non-declaration the department can see,
   * because it knows the merchant paid a foreign supplier.
   */
  const sections = (data: Gstr3bReturn) => buildGstr3bSections(data);

  describe('reverse charge — 3.1(d) and 4(A)(3)', () => {
    it('emits both legs, carrying equal IGST', () => {
      const sections = buildGstr3bSections(gstr3b);

      // 1,000 of imported service at 18% = 180, self-paid then reclaimed.
      expect(find(sections, '3.1(d)').rows[0].slice(0, 2)).toEqual([1000, 180]);
      expect(find(sections, '4(A)(3)').rows[0][0]).toBe(180);
    });

    it('does NOT add reverse charge to tax payable', () => {
      // The load-bearing assertion. 3.1(d) is settled in cash and reclaimed the
      // same period; folding it into output tax would overstate what is owed on
      // sales. 20 + 540 outward = 560, and the 180 above must not appear.
      const sections = buildGstr3bSections(gstr3b);

      expect(find(sections, '5.1').rows[0]).toEqual([0, 0, 560, 560]);
    });

    it('names 4(A)(3), never "Table 4"', () => {
      // Table 4 also holds 4(A)(5), all other ITC on domestic purchases, which
      // this system does not track. Naming the sub-row is what stops the block
      // implying a completeness it does not have.
      expect(GSTR3B_SECTION_RCM_ITC).toContain('4(A)(3)');
      expect(find(sections(gstr3b), '4(A)(3)').rows[0][1]).toMatch(/4\(A\)\(5\)/);
    });

    it('prompts rather than staying silent when nothing is recorded', () => {
      // A missing row is how a foreign subscription goes undeclared for a year.
      // An explicit zero with a prompt is what makes someone check.
      const empty = buildGstr3bSections({
        ...gstr3b,
        reverseCharge: { taxableValue: 0, igst: 0, entriesWithUnknownTax: 0 },
      });

      const row = find(empty, '3.1(d)').rows[0];
      expect(row.slice(0, 2)).toEqual([0, 0]);
      expect(String(row[2])).toMatch(/Nothing recorded/i);
    });

    it('marks the figure INCOMPLETE when a supply states no tax', () => {
      // An unstated tax is not zero. The IGST shown is a floor, and saying so
      // is the difference between a claim someone tops up and one they file.
      const partial = buildGstr3bSections({
        ...gstr3b,
        reverseCharge: { taxableValue: 1500, igst: 180, entriesWithUnknownTax: 1 },
      });

      expect(String(find(partial, '3.1(d)').rows[0][2])).toMatch(/INCOMPLETE/);
    });

    it('places both legs between 3.2 and 5.1', () => {
      // Statutory order — an accountant reads down the file.
      const titles = sections(gstr3b).map((s) => s.title);
      const at = (prefix: string) =>
        titles.findIndex((t) => t.startsWith(prefix));

      expect(at('3.2')).toBeLessThan(at('3.1(d)'));
      expect(at('3.1(d)')).toBeLessThan(at('4(A)(3)'));
      expect(at('4(A)(3)')).toBeLessThan(at('5.1'));
    });
  });
});

const gstr1: Gstr1Return = {
  b2b: [
    {
      buyerGstin: '29AABCU9603R1ZM',
      buyerName: 'Acme, Retail Pvt Ltd',
      invoiceCount: 1,
      invoices: [
        {
          invoiceNumber: 'INV-2025-26/000001',
          invoiceDate: new Date('2025-04-10T00:00:00.000Z'),
          reverseCharge: false,
          placeOfSupply: '29',
          placeOfSupplyName: 'Karnataka',
          gstType: GstType.IGST,
          subtotal: 1000,
          cgst: 0,
          sgst: 0,
          igst: 180,
          totalTax: 180,
          grandTotal: 1180,
        },
      ],
      totalTaxable: 1000,
      totalTax: 180,
    },
  ],
  b2cl: [
    {
      invoiceNumber: 'INV-2025-26/000009',
      invoiceDate: new Date('2025-04-20T00:00:00.000Z'),
      placeOfSupply: '24',
      placeOfSupplyName: 'Gujarat',
      gstRate: 18,
      taxableValue: 100000,
      igst: 18000,
      invoiceValue: 118000,
    },
  ],
  b2cs: [
    {
      placeOfSupply: '27',
      placeOfSupplyName: 'Maharashtra',
      gstRate: 5,
      supplyType: 'INTRA',
      taxableValue: 400,
      cgst: 10,
      sgst: 10,
      igst: 0,
    },
    {
      placeOfSupply: '27',
      placeOfSupplyName: 'Maharashtra',
      gstRate: 18,
      supplyType: 'INTRA',
      taxableValue: 1000,
      cgst: 90,
      sgst: 90,
      igst: 0,
    },
  ],
  b2cSummary: [
    {
      placeOfSupply: '27',
      placeOfSupplyName: 'Maharashtra',
      invoiceCount: 3,
      totalTaxable: 1400,
      totalCgst: 100,
      totalSgst: 100,
      totalIgst: 0,
      totalTax: 200,
    },
  ],
  hsnSummary: [
    {
      recipientType: 'B2C' as const,
      hsnCode: '6109',
      description: 'Cotton Shirt',
      uqc: 'PCS',
      gstRate: 18,
      quantity: 5,
      totalValue: 2950,
      taxableValue: 2500,
      cgst: 0,
      sgst: 0,
      igst: 450,
    },
    {
      recipientType: 'B2C' as const,
      hsnCode: null,
      description: 'Unclassified Item',
      uqc: 'NOS',
      gstRate: 18,
      quantity: 1,
      totalValue: 354,
      taxableValue: 300,
      cgst: 0,
      sgst: 0,
      igst: 54,
    },
  ],
  creditNotes: [],
  nilRated: [
    {
      section: '8C',
      description: 'Inter-State supplies to unregistered persons',
      nilRated: 100,
      exempted: 200,
      nonGst: 300,
    },
  ],
  totals: {
    totalTaxable: 1900,
    totalCgst: 100,
    totalSgst: 100,
    totalIgst: 180,
    totalTax: 380,
    totalInvoices: 4,
    linesMissingHsn: 1,
    grossTaxable: 1900,
    creditNoteCount: 0,
    creditNoteTaxable: 0,
    creditNoteTax: 0,
  },
};

describe('buildGstr1Sections', () => {
  it('emits every statutory table, each with its own header block', () => {
    const titles = buildGstr1Sections(gstr1).map((s) => s.title);

    expect(titles[0]).toContain('4A');
    expect(titles[1]).toContain('5 —');
    expect(titles[2]).toContain('7 —');
    expect(titles[3]).toContain('8 —');
    // 9B splits into CDNR and CDNUR, matching the form.
    expect(titles[4]).toContain('9B');
    expect(titles[5]).toContain('9B');
    // Table 12 splits into HSN-B2B and HSN-B2C, as the portal has reported it
    // since the May-2025 period. Both are emitted even when one is empty.
    expect(titles[6]).toBe('12 — HSN summary (B2B)');
    expect(titles[7]).toBe('12 — HSN summary (B2C)');
    // Table 13 only appears when the service attached it; this fixture has none.
    expect(titles).toHaveLength(8);
  });

  it('emits Table 13 only when documents issued were attached', () => {
    expect(
      buildGstr1Sections(gstr1).some((s) => s.title.startsWith('13')),
    ).toBe(false);

    const withDocs = buildGstr1Sections({
      ...gstr1,
      documentsIssued: {
        unparsed: 0,
        rows: [
          {
            nature: 'Invoices for outward supply',
            series: 'INV',
            financialYear: '26-27',
            from: '000001',
            to: '000003',
            total: 3,
            documents: 3,
            cancelled: 1,
            netIssued: 2,
          },
        ],
      },
    });

    const section = find(withDocs, '13');
    expect(section.headers).toContain('Sr. No. from');
    expect(section.rows[0]).toEqual([
      'Invoices for outward supply',
      'INV',
      '26-27',
      '000001',
      '000003',
      3,
      3,
      1,
      2,
    ]);
  });

  it('routes HSN rows to the tab matching their recipient type', () => {
    const sections = buildGstr1Sections({
      ...gstr1,
      hsnSummary: [
        { ...gstr1.hsnSummary[0], recipientType: 'B2B' as const },
        gstr1.hsnSummary[1],
      ],
    });

    expect(find(sections, '12 — HSN summary (B2B)').rows).toHaveLength(1);
    expect(find(sections, '12 — HSN summary (B2B)').rows[0][0]).toBe('6109');
    expect(find(sections, '12 — HSN summary (B2C)').rows).toHaveLength(1);
    expect(find(sections, '12 — HSN summary (B2C)').rows[0][0]).toBe('MISSING');
  });

  it('gives Table 12 the UQC and rate columns it legally requires', () => {
    // These could not exist in the old shared 12-column row — there was no
    // spare column, and the quantity was already being smuggled into
    // `grandTotal` as a formatted string.
    const section = find(buildGstr1Sections(gstr1), '12 — HSN summary (B2C)');

    expect(section.headers).toContain('UQC');
    expect(section.headers).toContain('Rate');
    expect(section.headers).toContain('Total quantity');
    expect(section.rows[0]).toEqual([
      '6109',
      'Cotton Shirt',
      'PCS',
      '18%',
      5,
      2950,
      2500,
      0,
      0,
      450,
    ]);
  });

  it('names a missing HSN instead of inventing one or leaving it blank', () => {
    // The old code wrote the literal '0000', which is not a valid HSN and went
    // onto a statutory document. A blank would read as an export bug.
    const section = find(buildGstr1Sections(gstr1), '12 — HSN summary (B2C)');

    expect(section.rows[1][0]).toBe('MISSING');
    expect(section.rows.some((r) => r[0] === '0000')).toBe(false);
  });

  it('reports B2CL invoice-wise and B2CS rate-wise', () => {
    const sections = buildGstr1Sections(gstr1);

    expect(find(sections, '5 —').headers).toContain('Invoice number');
    expect(find(sections, '5 —').rows[0][0]).toBe('INV-2025-26/000009');

    const b2cs = find(sections, '7 —');
    expect(b2cs.headers).toContain('Rate');
    expect(b2cs.rows.map((r) => r[2])).toEqual(['5%', '18%']);
  });

  it('formats dates and place of supply consistently', () => {
    const b2b = find(buildGstr1Sections(gstr1), '4A');

    expect(b2b.rows[0][3]).toBe('2025-04-10');
    expect(b2b.rows[0][4]).toBe('29 - Karnataka');
  });
});

describe('renderCsvSections', () => {
  it('separates blocks with a blank line and repeats no header', () => {
    const csv = renderCsvSections([
      { title: 'One', headers: ['A', 'B'], rows: [[1, 2]] },
      { title: 'Two', headers: ['C'], rows: [[3]] },
    ]);

    expect(csv).toBe('One\r\nA,B\r\n1,2\r\n\r\nTwo\r\nC\r\n3');
  });

  it('quotes a value containing a comma', () => {
    // Buyer names routinely contain commas; without quoting the row shifts by
    // one column and every figure after it lands under the wrong header.
    const csv = renderCsvSections([
      { title: 'T', headers: ['Name'], rows: [['Acme, Retail Pvt Ltd']] },
    ]);

    expect(csv).toContain('"Acme, Retail Pvt Ltd"');
  });

  it('escapes an embedded quote by doubling it', () => {
    const csv = renderCsvSections([
      { title: 'T', headers: ['Name'], rows: [['The "Big" Store']] },
    ]);

    expect(csv).toContain('"The ""Big"" Store"');
  });

  it('quotes a value containing a newline rather than breaking the row', () => {
    const csv = renderCsvSections([
      { title: 'T', headers: ['Addr'], rows: [['Line1\nLine2']] },
    ]);

    expect(csv).toContain('"Line1\nLine2"');
  });

  it('renders a real buyer name from the B2B section safely', () => {
    // End to end: the fixture buyer is "Acme, Retail Pvt Ltd".
    const csv = renderCsvSections(buildGstr1Sections(gstr1));

    expect(csv).toContain('"Acme, Retail Pvt Ltd"');
  });
});
