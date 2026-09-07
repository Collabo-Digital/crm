import { formatPlaceOfSupply } from '../gst/constants/indian-states';
import type { Gstr1Return, Gstr3bReturn } from './gst-return.accumulator';

/**
 * Shapes a generated return into the downloaded CSV.
 *
 * WHY SECTIONS RATHER THAN ONE FLAT TABLE. Every section used to share a single
 * fixed 12-column row, which forced two columns to carry the wrong thing: the
 * HSN summary put its code in the `invoiceNumber` column and the string
 * `"Qty: 6"` in `grandTotal`, and the B2C summary put `"3 invoices"` in
 * `invoiceNumber`. Beyond being unreadable, it left no column free — Table 12
 * legally needs a UQC and a rate, and neither could be added without changing
 * the column count of every other section.
 *
 * Each statutory table now owns its own header block, so it can carry exactly
 * the columns the statute asks for.
 *
 * Section titles carry the GSTR table numbers on purpose. On the real GSTR-3B
 * form, 3.2 is a MEMO BREAKDOWN of supplies already inside 3.1 — the previous
 * export wrote it as a sibling row, so anyone summing the tax column
 * double-counted the file they were about to file.
 */

export interface CsvSection {
  /** Statutory table label, e.g. "12 — HSN summary". */
  title: string;
  headers: string[];
  rows: Array<Array<string | number>>;
}

/** RFC-4180 field escaping. */
function escapeCsv(value: string | number): string {
  const text = value === null || value === undefined ? '' : String(value);
  // Quote when the value contains a delimiter, a quote, or a line break —
  // buyer names and addresses routinely contain commas.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Render sections into one CSV document.
 *
 * A blank line separates blocks. Spreadsheet software treats the result as one
 * sheet with several stacked tables, which is what an accountant reading a
 * sectioned return expects.
 */
export function renderCsvSections(sections: CsvSection[]): string {
  const blocks = sections.map((section) => {
    const lines = [
      escapeCsv(section.title),
      section.headers.map(escapeCsv).join(','),
      ...section.rows.map((row) => row.map(escapeCsv).join(',')),
    ];
    return lines.join('\r\n');
  });

  return blocks.join('\r\n\r\n');
}

const HSN_MISSING = 'MISSING';

function toDateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().split('T')[0];
}

export function buildGstr1Sections(data: Gstr1Return): CsvSection[] {
  const sections: CsvSection[] = [];

  sections.push({
    title: '4A — B2B invoices (supplies to registered persons)',
    headers: [
      'Buyer GSTIN',
      'Buyer name',
      'Invoice number',
      'Invoice date',
      'Place of supply',
      'Supply type',
      // Rule 46(p), and the column the offline utility's B2B sheet uses to
      // separate table 4B from 4A.
      'Reverse charge',
      'Taxable value',
      'CGST',
      'SGST',
      'IGST',
      'Total tax',
      'Invoice value',
    ],
    rows: (data.b2b ?? []).flatMap((group) =>
      (group.invoices ?? []).map((inv) => [
        group.buyerGstin,
        group.buyerName,
        inv.invoiceNumber,
        toDateOnly(inv.invoiceDate),
        formatPlaceOfSupply(inv.placeOfSupply, inv.placeOfSupplyName),
        inv.gstType === 'IGST' ? 'Inter-State' : 'Intra-State',
        inv.reverseCharge ? 'Y' : 'N',
        inv.subtotal,
        inv.cgst,
        inv.sgst,
        inv.igst,
        inv.totalTax,
        inv.grandTotal,
      ]),
    ),
  });

  sections.push({
    title: '5 — B2CL (inter-State supplies to unregistered persons, above threshold)',
    headers: [
      'Invoice number',
      'Invoice date',
      'Place of supply',
      'Rate',
      'Taxable value',
      'IGST',
      'Invoice value',
    ],
    rows: (data.b2cl ?? []).map((row) => [
      row.invoiceNumber,
      toDateOnly(row.invoiceDate),
      formatPlaceOfSupply(row.placeOfSupply, row.placeOfSupplyName),
      `${row.gstRate}%`,
      row.taxableValue,
      row.igst,
      row.invoiceValue,
    ]),
  });

  sections.push({
    title: '7 — B2CS (other supplies to unregistered persons, rate-wise)',
    headers: [
      'Place of supply',
      'Supply type',
      'Rate',
      'Taxable value',
      'CGST',
      'SGST',
      'IGST',
    ],
    rows: (data.b2cs ?? []).map((row) => [
      formatPlaceOfSupply(row.placeOfSupply, row.placeOfSupplyName),
      row.supplyType === 'INTER' ? 'Inter-State' : 'Intra-State',
      `${row.gstRate}%`,
      row.taxableValue,
      row.cgst,
      row.sgst,
      row.igst,
    ]),
  });

  sections.push({
    title: '8 — Nil-rated, exempted and non-GST outward supplies',
    headers: ['Section', 'Description', 'Nil rated', 'Exempted', 'Non-GST'],
    rows: (data.nilRated ?? []).map((row) => [
      row.section,
      row.description,
      row.nilRated,
      row.exempted,
      row.nonGst,
    ]),
  });

  // 9B before 12, matching the order of the statutory form.
  sections.push({
    title: '9B — Credit notes against registered persons (CDNR)',
    headers: [
      'Note number',
      'Note date',
      'Buyer GSTIN',
      'Original invoice',
      'Place of supply',
      'Reason',
      'Taxable value',
      'CGST',
      'SGST',
      'IGST',
      'Note value',
    ],
    rows: (data.creditNotes ?? [])
      .filter((n) => n.section === 'CDNR')
      .map((n) => [
        n.noteNumber,
        toDateOnly(n.noteDate),
        n.buyerGstin ?? '',
        n.originalInvoiceNumber ?? '',
        formatPlaceOfSupply(n.placeOfSupply, n.placeOfSupplyName),
        n.reason ?? '',
        n.taxableValue,
        n.cgst,
        n.sgst,
        n.igst,
        n.noteValue,
      ]),
  });

  sections.push({
    title: '9B — Credit notes against unregistered persons (CDNUR)',
    headers: [
      'Note number',
      'Note date',
      'Original invoice',
      'Place of supply',
      'Reason',
      'Taxable value',
      'CGST',
      'SGST',
      'IGST',
      'Note value',
    ],
    rows: (data.creditNotes ?? [])
      .filter((n) => n.section === 'CDNUR')
      .map((n) => [
        n.noteNumber,
        toDateOnly(n.noteDate),
        n.originalInvoiceNumber ?? '',
        formatPlaceOfSupply(n.placeOfSupply, n.placeOfSupplyName),
        n.reason ?? '',
        n.taxableValue,
        n.cgst,
        n.sgst,
        n.igst,
        n.noteValue,
      ]),
  });

  // Table 12 is TWO tables from the May-2025 return period onward: the portal
  // reports HSN-B2B and HSN-B2C on separate tabs, each reconciling to its own
  // supplies. Emitting one merged table produced a file no current period
  // accepts. Both are always emitted, empty or not, so the reader can see which
  // side a figure was expected on.
  const hsnRows = data.hsnSummary ?? [];
  for (const side of ['B2B', 'B2C'] as const) {
    sections.push({
      title: `12 — HSN summary (${side})`,
      headers: [
        'HSN',
        'Description',
        'UQC',
        'Rate',
        'Total quantity',
        'Total value',
        'Taxable value',
        'CGST',
        'SGST',
        'IGST',
      ],
      rows: hsnRows
        .filter((row) => row.recipientType === side)
        .map((row) => [
          // Never invent a code. A blank would look like an export bug, so the
          // gap is named — this column must be filled before filing.
          row.hsnCode ?? HSN_MISSING,
          row.description,
          row.uqc,
          `${row.gstRate}%`,
          row.quantity,
          row.totalValue,
          row.taxableValue,
          row.cgst,
          row.sgst,
          row.igst,
        ]),
    });
  }

  // Table 13 — documents issued. Mandatory whenever outward supplies are
  // reported. Only rendered when the service attached it (GSTR-1 only).
  if (data.documentsIssued) {
    sections.push({
      title: '13 — Documents issued',
      headers: [
        'Nature of document',
        'Series',
        'Financial year',
        'Sr. No. from',
        'Sr. No. to',
        'Total number',
        'Documents present',
        'Cancelled',
        'Net issued',
      ],
      rows: data.documentsIssued.rows.map((row) => [
        row.nature,
        row.series,
        row.financialYear,
        row.from,
        row.to,
        row.total,
        // Reported beside the span rather than instead of it: a difference is
        // either a real serial gap or the effect of scoping to one GSTIN while
        // the numbering series runs org-wide. Averaging them would hide both.
        row.documents,
        row.cancelled,
        row.netIssued,
      ]),
    });
  }

  return sections;
}

export const GSTR3B_SECTION_OUTWARD = '3.1(a) — Outward taxable supplies';
export const GSTR3B_SECTION_OTHER =
  '3.1(b)(c)(e) — Zero-rated, nil-rated/exempt and non-GST supplies';
export const GSTR3B_SECTION_INTERSTATE =
  '3.2 — Inter-State supplies to unregistered persons (memo of 3.1)';
export const GSTR3B_SECTION_OUTWARD_RCM =
  '3.1(a) note — Outward supplies under reverse charge (tax payable by recipient)';
export const GSTR3B_SECTION_REVERSE_CHARGE =
  '3.1(d) — Inward supplies liable to reverse charge';
/**
 * 4(A)(3) SPECIFICALLY, never "Table 4".
 *
 * Table 4 as a whole includes 4(A)(5), all other ITC on domestic purchases,
 * which this system does not track. Naming the sub-row is what stops the block
 * implying a completeness it does not have.
 */
export const GSTR3B_SECTION_RCM_ITC =
  '4(A)(3) — ITC on inward supplies liable to reverse charge';
export const GSTR3B_SECTION_PAYABLE = '5.1 — Tax payable';

export function buildGstr3bSections(data: Gstr3bReturn): CsvSection[] {
  return [
    {
      title: GSTR3B_SECTION_OUTWARD,
      headers: ['Rate', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Total tax'],
      rows: (data.outwardSupplies ?? []).map((row) => [
        `${row.gstRate}%`,
        row.taxableValue,
        row.cgst,
        row.sgst,
        row.igst,
        row.totalTax,
      ]),
    },
    {
      title: GSTR3B_SECTION_OTHER,
      // 3.1(b) carries an integrated-tax column on the form: an export made
      // WITHOUT an LUT is zero-rated but made on payment of IGST, and that tax
      // is declared here. (c) and (e) never carry tax, so their cell is blank
      // rather than a zero that invites a total down the column.
      headers: ['Nature of supply', 'Taxable value', 'IGST'],
      rows: [
        [
          '(b) Zero-rated (exports / SEZ)',
          data.otherSupplies?.zeroRated ?? 0,
          data.otherSupplies?.zeroRatedIgst ?? 0,
        ],
        ['(c) Nil-rated and exempted', data.otherSupplies?.nilRatedExempt ?? 0, ''],
        ['(e) Non-GST outward supplies', data.otherSupplies?.nonGst ?? 0, ''],
      ],
    },
    {
      // A MEMO of 3.1, not an addition to it — stated in the title so nobody
      // sums this column into the total.
      title: GSTR3B_SECTION_INTERSTATE,
      headers: ['Place of supply', 'Invoices', 'Taxable value', 'IGST'],
      rows: (data.interState?.byState ?? []).map((row) => [
        formatPlaceOfSupply(row.placeOfSupply, row.placeOfSupplyName),
        row.invoiceCount,
        row.totalTaxable,
        row.totalIgst,
      ]),
    },
    // Outward supplies the RECIPIENT pays tax on. Excluded from 3.1(a), 3.2
    // and 5.1 above, because the portal's own 3.1(a) is built from GSTR-1
    // tables that omit 4B. Shown so the exclusion is visible and reconcilable
    // rather than an unexplained shortfall against the sales figures.
    {
      title: GSTR3B_SECTION_OUTWARD_RCM,
      headers: ['Invoices', 'Taxable value', 'Tax not payable by you', 'Note'],
      rows: [
        [
          data.outwardReverseCharge?.invoiceCount ?? 0,
          data.outwardReverseCharge?.taxableValue ?? 0,
          data.outwardReverseCharge?.tax ?? 0,
          (data.outwardReverseCharge?.unregisteredRecipients ?? 0) > 0
            ? `${data.outwardReverseCharge!.unregisteredRecipients} of these have no buyer GSTIN — reverse charge on outward supplies is B2B, so check those invoices.`
            : 'Reported in GSTR-1 table 4B; the recipient declares this tax in their own 3.1(d).',
        ],
      ],
    },
    // 3.1(d) and 4(A)(3) — the two legs of reverse charge, in statutory order
    // between 3.2 and the payment section.
    //
    // Emitted even when zero: silence is what lets a merchant forget that a
    // foreign subscription is declarable at all, and a zero row prompts the
    // question. The note carries the floor caveat when a tax was never stated.
    {
      title: GSTR3B_SECTION_REVERSE_CHARGE,
      headers: ['Taxable value', 'IGST', 'Note'],
      rows: [
        [
          data.reverseCharge?.taxableValue ?? 0,
          data.reverseCharge?.igst ?? 0,
          reverseChargeNote(data.reverseCharge),
        ],
      ],
    },
    {
      title: GSTR3B_SECTION_RCM_ITC,
      headers: ['IGST', 'Note'],
      rows: [
        [
          data.reverseCharge?.igst ?? 0,
          // Equal to 3.1(d) by construction — you reclaim exactly what you
          // self-paid — which is why the pair nets to nothing in cash.
          'Equal to the 3.1(d) tax above; the two net to nil in cash. Excludes all other ITC (4(A)(5)), which this system does not track.',
        ],
      ],
    },
    {
      title: GSTR3B_SECTION_PAYABLE,
      headers: ['CGST', 'SGST', 'IGST', 'Total'],
      rows: [
        [
          data.taxPayable?.cgst ?? 0,
          data.taxPayable?.sgst ?? 0,
          data.taxPayable?.igst ?? 0,
          data.taxPayable?.total ?? 0,
        ],
      ],
    },
  ];
}

/** Says plainly when 3.1(d) is a floor rather than the full figure. */
function reverseChargeNote(
  reverseCharge: Gstr3bReturn['reverseCharge'] | undefined,
): string {
  if (!reverseCharge || reverseCharge.taxableValue === 0) {
    return 'Nothing recorded. Foreign services (Shopify, Google Ads, AWS…) are declarable here.';
  }
  if (reverseCharge.entriesWithUnknownTax > 0) {
    return `INCOMPLETE — ${reverseCharge.entriesWithUnknownTax} recorded ${
      reverseCharge.entriesWithUnknownTax === 1 ? 'supply states' : 'supplies state'
    } no tax amount, so the IGST above is a floor.`;
  }
  return 'Self-paid, then reclaimed in 4(A)(3) below.';
}
