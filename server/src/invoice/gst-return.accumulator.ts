import { Prisma } from '@prisma/client';
import { GstSupplyType, GstType, InvoiceStatus } from '@prisma/client';
import {
  getStateName,
  UNSPECIFIED_PLACE_OF_SUPPLY,
} from '../gst/constants/indian-states';

/**
 * Streaming aggregators for GSTR-1 and GSTR-3B.
 *
 * WHY THIS EXISTS, rather than the old "load everything then group" code:
 *
 * 1. `getGstReturn` used to `findMany({ take: 10_000 })` with no `orderBy`, so
 *    a period with more invoices than that produced a NON-DETERMINISTIC SUBSET
 *    and reported it as the whole return, with no signal to the caller. For a
 *    statutory filing, silently under-reporting is the worst available failure.
 *    The service now pages with a cursor and folds each page in here, so no row
 *    is ever dropped.
 *
 * 2. Folding is what actually bounds memory. Cursoring into one big array would
 *    keep exactly the footprint we are trying to avoid, because the expensive
 *    part is `include: { lineItems: true }`. Line items are consumed into the
 *    HSN and rate maps as each page arrives and are then garbage; peak retention
 *    is O(distinct HSN codes + distinct states + B2B invoice rows). GSTR-1's B2B
 *    section is invoice-wise by statute, so those projected rows must be kept —
 *    but they are ten scalars each, not a hydrated row with its line items.
 *
 * 3. Money accumulates in `Prisma.Decimal`, not `number`. The previous code
 *    summed floats across every invoice in the period and rounded once at the
 *    end (`sumField`), so error accumulated across thousands of additions before
 *    anything was rounded. Statutory money should never travel through binary
 *    floating point.
 *
 * Both accumulators are pure and take plain objects, so they unit-test without
 * Prisma or a Nest testing module.
 */

const ZERO = new Prisma.Decimal(0);

/** Sum in Decimal, convert to a 2dp number exactly once, at the end. */
function toMoney(value: Prisma.Decimal): number {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** Coerce a Prisma Decimal | string | number | null into a Decimal. */
function dec(value: unknown): Prisma.Decimal {
  if (value === null || value === undefined) return ZERO;
  if (value instanceof Prisma.Decimal) return value;
  try {
    return new Prisma.Decimal(value as Prisma.Decimal.Value);
  } catch {
    return ZERO;
  }
}

// ─── SHAPES ───
// These mirror the client's `GstReturnGstr1` / `GstReturnGstr3B` in
// client/app/types/api.ts. The public JSON contract is unchanged by this
// rewrite — only how the numbers are reached.

export interface ReturnLineItem {
  /** Null since Phase 2. The legacy literal '0000' also means "missing". */
  hsnCode: string | null;
  unitOfMeasure: string | null;
  supplyType: GstSupplyType;
  description: string;
  quantity: number;
  taxableValue: unknown;
  gstRate: unknown;
  cgstAmount: unknown;
  sgstAmount: unknown;
  igstAmount: unknown;
  totalTax: unknown;
}

export interface ReturnInvoice {
  /**
   * ISSUED or CREDIT_NOTE. Both are folded from the same query, because a
   * credit note is shaped like an invoice and must appear in the same return —
   * but it is reported in Table 9B and NETTED, never added.
   */
  status: InvoiceStatus;
  /** Set on a credit note: the invoice it reverses. */
  creditNoteForId?: string | null;
  /** Number of the invoice being reversed — Table 9B reports it. */
  creditNoteForNumber?: string | null;
  creditNoteReason?: string | null;
  invoiceNumber: string;
  invoiceDate: Date | string;
  buyerGstin: string | null;
  buyerName: string;
  placeOfSupply: string | null;
  placeOfSupplyName: string | null;
  gstType: GstType;
  /**
   * Tax payable by the RECIPIENT (Rule 46(p)). Optional so existing fixtures
   * and the untyped service cast keep compiling; absent means forward charge.
   */
  reverseCharge?: boolean;
  subtotal: unknown;
  totalCgst: unknown;
  totalSgst: unknown;
  totalIgst: unknown;
  totalTax: unknown;
  grandTotal: unknown;
  lineItems: ReturnLineItem[];
}

export interface Gstr1B2bInvoiceRow {
  invoiceNumber: string;
  invoiceDate: Date | string;
  placeOfSupply: string | null;
  placeOfSupplyName: string | null;
  gstType: GstType;
  /** True puts this invoice in table 4B rather than 4A. */
  reverseCharge: boolean;
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  grandTotal: number;
}

export interface Gstr1B2clInvoiceRow {
  invoiceNumber: string;
  invoiceDate: Date | string;
  placeOfSupply: string;
  placeOfSupplyName: string;
  gstRate: number;
  taxableValue: number;
  igst: number;
  invoiceValue: number;
}

export interface Gstr1B2csRow {
  placeOfSupply: string;
  placeOfSupplyName: string;
  gstRate: number;
  supplyType: 'INTER' | 'INTRA';
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface Gstr1HsnRow {
  /**
   * Which HSN tab this row belongs to.
   *
   * From the May-2025 return period the portal splits Table 12 into HSN-B2B
   * and HSN-B2C, each reconciling to its own supplies. One merged table is
   * rejected, so the split has to exist in the data, not only in the render.
   */
  recipientType: 'B2B' | 'B2C';
  /** Null when the product carries no HSN. Rendered as a warning, never as a code. */
  hsnCode: string | null;
  description: string;
  uqc: string;
  gstRate: number;
  quantity: number;
  totalValue: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * GSTR-1 Table 13 — documents issued.
 *
 * Optional because it is not produced by the accumulator: serial ranges must
 * include CANCELLED invoices, which the return's fold excludes by design. The
 * service attaches it after folding.
 */
import type { DocumentSeriesSummary } from './document-series.util';
export type { DocumentSeriesSummary };

/** One row of GSTR-1 Table 8 — supplies attracting no tax. */
export interface Gstr1NilRatedRow {
  /** 8A / 8B / 8C / 8D. */
  section: string;
  description: string;
  nilRated: number;
  exempted: number;
  nonGst: number;
}

/** One GSTR-1 Table 9B row — a credit or debit note against a prior invoice. */
export interface Gstr1CreditNoteRow {
  /** CDNR when the buyer is registered, CDNUR when they are not. */
  section: 'CDNR' | 'CDNUR';
  noteNumber: string;
  noteDate: Date | string;
  buyerGstin: string | null;
  buyerName: string;
  originalInvoiceNumber: string | null;
  placeOfSupply: string;
  placeOfSupplyName: string;
  reason: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  noteValue: number;
}

export interface Gstr1Return {
  b2b: Array<{
    buyerGstin: string;
    buyerName: string;
    invoiceCount: number;
    invoices: Gstr1B2bInvoiceRow[];
    totalTaxable: number;
    totalTax: number;
  }>;
  /** Table 5 — inter-state B2C above the threshold, reported invoice-wise. */
  b2cl: Gstr1B2clInvoiceRow[];
  /** Table 7 — everything else B2C, by place of supply AND rate. */
  b2cs: Gstr1B2csRow[];
  /**
   * Retained for compatibility with the existing panel and the reconciliation
   * harness: the same population as b2cl + b2cs, grouped by place of supply
   * only. NOT filable on its own — that is what b2cl/b2cs are for.
   */
  b2cSummary: Array<{
    placeOfSupply: string;
    placeOfSupplyName: string;
    invoiceCount: number;
    totalTaxable: number;
    totalCgst: number;
    totalSgst: number;
    totalIgst: number;
    totalTax: number;
  }>;
  /** Table 12 — by recipient type, HSN, rate and UQC. */
  hsnSummary: Gstr1HsnRow[];
  /**
   * Table 13 — documents issued. Attached by the service after folding, since
   * serial ranges must count CANCELLED invoices that the fold excludes.
   */
  documentsIssued?: DocumentSeriesSummary;
  /** Table 8 — nil-rated, exempted and non-GST outward supplies. */
  nilRated: Gstr1NilRatedRow[];
  /** Table 9B — credit notes against earlier invoices (CDNR / CDNUR). */
  creditNotes: Gstr1CreditNoteRow[];
  totals: {
    totalTaxable: number;
    totalCgst: number;
    totalSgst: number;
    totalIgst: number;
    totalTax: number;
    totalInvoices: number;
    /** Lines with no HSN code — the count that must reach zero before filing. */
    linesMissingHsn: number;
    /**
     * Invoice totals BEFORE credit notes are deducted.
     *
     * `totalTaxable` and the tax figures above are NET, because that is what
     * gets filed. These are kept alongside so the deduction is visible rather
     * than implied, and so table 12 — which reports invoice lines, not notes —
     * can still be reconciled against something.
     */
    grossTaxable: number;
    creditNoteCount: number;
    creditNoteTaxable: number;
    creditNoteTax: number;
  };
}

export interface Gstr3bReturn {
  outwardSupplies: Array<{
    gstRate: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalTax: number;
  }>;
  /**
   * 3.1(b), (c) and (e). Before Phase 2 nothing classified a supply, so every
   * invoice was row (a) and these were permanently empty.
   *
   * (c) and (e) genuinely carry no tax. (b) can: an export is zero-rated either
   * way, but a supplier who has NOT furnished an LUT exports on payment of
   * IGST and reports that tax on this row — the form gives 3.1(b) an integrated
   * tax column for exactly that case. Without `zeroRatedIgst` such an export
   * had its taxable value in (b) and its IGST nowhere, so `taxPayable` could
   * not be reconciled against the rows above it.
   */
  otherSupplies: {
    zeroRated: number;
    /** IGST on zero-rated supplies — exports made on payment of tax. */
    zeroRatedIgst: number;
    nilRatedExempt: number;
    nonGst: number;
  };
  interState: {
    invoiceCount: number;
    totalTaxable: number;
    totalIgst: number;
    byState: Array<{
      placeOfSupply: string;
      placeOfSupplyName: string;
      invoiceCount: number;
      totalTaxable: number;
      totalIgst: number;
    }>;
  };
  /**
   * OUTWARD supplies on which the recipient pays the tax (GSTR-1 table 4B).
   *
   * Excluded from `outwardSupplies` (3.1(a)), from `interState` (3.2) and from
   * `taxPayable`, because the portal's system-computed 3.1(a) is built from
   * GSTR-1 tables 4A/4C/5/6C/7/9/10/11 and omits 4B: the supplier owes nothing,
   * and the recipient declares the same tax in their own 3.1(d). Reported here
   * so the figure is visible rather than silently dropped.
   *
   * Distinct from `reverseCharge` below, which is INWARD.
   */
  outwardReverseCharge?: {
    invoiceCount: number;
    taxableValue: number;
    tax: number;
    /**
     * How many carried no buyer GSTIN. Reverse charge on outward supplies runs
     * B2B, so a non-zero count almost certainly means a mis-flagged invoice.
     */
    unregisteredRecipients: number;
  };
  /**
   * 3.1(d) and 4(A)(3) — inward supplies on which the RECIPIENT pays the tax.
   *
   * Not produced by this accumulator: it folds invoices, which are outward, and
   * these are purchases. `InvoiceService.getGstReturn` fills them from the
   * period's recorded inward supplies and hands them through here so the return
   * payload is one object.
   *
   * ⚠️ Deliberately absent from `taxPayable`. Reverse charge is settled in cash
   * and reclaimed as credit in the same period; adding it to output tax would
   * overstate what is owed on sales.
   */
  reverseCharge: {
    /** 3.1(d) — taxable value of the inward supplies. */
    taxableValue: number;
    /**
     * Always IGST. Scoped to imports of services, where the recipient's
     * location is the place of supply and the supplier sits outside India — so
     * inter-state by definition.
     */
    igst: number;
    /**
     * Entries whose tax was never stated. Above zero, the figures here are a
     * floor rather than the answer.
     */
    entriesWithUnknownTax: number;
  };
  taxPayable: {
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
  };
}

/** Normalised grouping key. A B2C invoice with no resolved state must not
 *  become the string "null" — it groups under the unspecified code instead. */
function posKey(invoice: ReturnInvoice): string {
  return invoice.placeOfSupply?.trim() || UNSPECIFIED_PLACE_OF_SUPPLY;
}

/** Table 8 splits by whether the buyer is registered and whether the supply
 *  crosses a state border. These are its four statutory rows. */
const NIL_RATED_SECTIONS: Array<{
  key: string;
  section: string;
  description: string;
}> = [
  { key: 'INTER|REG', section: '8A', description: 'Inter-State supplies to registered persons' },
  { key: 'INTRA|REG', section: '8B', description: 'Intra-State supplies to registered persons' },
  { key: 'INTER|UNREG', section: '8C', description: 'Inter-State supplies to unregistered persons' },
  { key: 'INTRA|UNREG', section: '8D', description: 'Intra-State supplies to unregistered persons' },
];

/**
 * Distinct product descriptions tracked per Table 12 row before we stop adding
 * new ones.
 *
 * This class exists to keep memory at O(distinct HSN + distinct states + B2B
 * rows) while folding up to 50,000 invoices, so an unbounded per-row set of
 * product names would quietly undo the guarantee it was built for. Past the cap
 * existing names keep accumulating and the surplus is counted, so the "+N more"
 * suffix stays truthful.
 */
const HSN_DESCRIPTION_CAP = 64;

/**
 * Describe a Table 12 row by the product carrying the most taxable value in it.
 *
 * The column used to hold whichever line was folded FIRST, discarding every
 * other name in the group — so an HSN covering four products was labelled with
 * one arbitrary one (in practice a 120-rupee test product standing in for 4,748
 * of snowboards), and which one won depended on the invoice-id sort order.
 *
 * Highest accumulated value wins, ties break on the string so the output is
 * stable, and the suffix says outright when the row is not one product.
 */
function describeHsnGroup(
  descriptions: Map<string, Prisma.Decimal>,
  overflow: number,
): string {
  let best = '';
  let bestValue: Prisma.Decimal | null = null;

  for (const [description, value] of descriptions) {
    if (
      bestValue === null ||
      value.greaterThan(bestValue) ||
      (value.equals(bestValue) && description < best)
    ) {
      best = description;
      bestValue = value;
    }
  }

  if (!best) return '';

  // Past the cap we no longer know how many DISTINCT products were dropped —
  // only that some were — so the suffix stops claiming a number rather than
  // printing one that counts repeats. An exact count is worth having; a wrong
  // one on a filed document is not.
  if (overflow > 0) return `${best} and others`;

  const others = descriptions.size - 1;
  return others > 0 ? `${best} +${others} more` : best;
}

export interface Gstr1AccumulatorOptions {
  /**
   * Invoice VALUE above which an inter-state B2C supply is reported
   * invoice-wise in Table 5 rather than summarised in Table 7.
   *
   * Compared against the invoice total, not the taxable value — the statute
   * speaks in invoice value. Passed in rather than imported so this class stays
   * pure and unit-testable at any threshold.
   */
  b2cLargeThreshold: number;
}

// ─── GSTR-1 ───

export class Gstr1Accumulator {
  private readonly b2cLargeThreshold: Prisma.Decimal;

  constructor(options: Gstr1AccumulatorOptions) {
    this.b2cLargeThreshold = new Prisma.Decimal(options.b2cLargeThreshold);
  }

  private readonly b2b = new Map<
    string,
    {
      buyerName: string;
      invoices: Gstr1B2bInvoiceRow[];
      totalTaxable: Prisma.Decimal;
      totalTax: Prisma.Decimal;
    }
  >();

  /** Table 5 rows, one per (invoice × rate). */
  private readonly b2cl: Gstr1B2clInvoiceRow[] = [];

  /** Table 7, keyed by place of supply × rate. */
  private readonly b2cs = new Map<
    string,
    {
      placeOfSupply: string;
      placeOfSupplyName: string | null;
      gstRate: number;
      supplyType: 'INTER' | 'INTRA';
      taxable: Prisma.Decimal;
      cgst: Prisma.Decimal;
      sgst: Prisma.Decimal;
      igst: Prisma.Decimal;
    }
  >();

  /** The pre-Phase-2 per-state roll-up, kept for the existing panel. */
  private readonly b2c = new Map<
    string,
    {
      placeOfSupplyName: string | null;
      invoiceCount: number;
      totalTaxable: Prisma.Decimal;
      totalCgst: Prisma.Decimal;
      totalSgst: Prisma.Decimal;
      totalIgst: Prisma.Decimal;
      totalTax: Prisma.Decimal;
    }
  >();

  /** Table 12, keyed by HSN × UQC × rate. */
  private readonly hsn = new Map<
    string,
    {
      recipientType: 'B2B' | 'B2C';
      hsnCode: string | null;
      /**
       * Taxable value per distinct product description in this group, so the
       * row can be described by what actually dominates it rather than by
       * whichever line happened to be folded first. Resolved to a single
       * string in `finish()`; capped at HSN_DESCRIPTION_CAP entries.
       */
      descriptions: Map<string, Prisma.Decimal>;
      /** Distinct descriptions seen after the cap was reached. */
      descriptionOverflow: number;
      uqc: string;
      gstRate: number;
      quantity: number;
      totalValue: Prisma.Decimal;
      taxable: Prisma.Decimal;
      cgst: Prisma.Decimal;
      sgst: Prisma.Decimal;
      igst: Prisma.Decimal;
    }
  >();

  /** Table 8, keyed by `${INTER|INTRA}|${REG|UNREG}`. */
  private readonly nilRated = new Map<
    string,
    { nilRated: Prisma.Decimal; exempted: Prisma.Decimal; nonGst: Prisma.Decimal }
  >();

  private totalTaxable = ZERO;
  private totalCgst = ZERO;
  private totalSgst = ZERO;
  private totalIgst = ZERO;
  private totalTax = ZERO;
  private totalInvoices = 0;
  private linesMissingHsn = 0;

  private readonly creditNoteRows: Gstr1CreditNoteRow[] = [];
  private creditNoteCount = 0;
  private creditNoteTaxable = ZERO;
  private creditNoteCgst = ZERO;
  private creditNoteSgst = ZERO;
  private creditNoteIgst = ZERO;
  private creditNoteTax = ZERO;

  addInvoice(invoice: ReturnInvoice): void {
    const subtotal = dec(invoice.subtotal);
    const cgst = dec(invoice.totalCgst);
    const sgst = dec(invoice.totalSgst);
    const igst = dec(invoice.totalIgst);
    const tax = dec(invoice.totalTax);
    const grandTotal = dec(invoice.grandTotal);

    const isInterState = invoice.gstType === GstType.IGST;
    const isRegistered = Boolean(invoice.buyerGstin);
    const pos = posKey(invoice);

    // A CREDIT NOTE is reported in Table 9B and NETTED out of the totals — it
    // is never added to 4A/5/7/8/12, which report invoices. Amounts are stored
    // positive (as they appear on the paper document), so the subtraction
    // happens here rather than by storing negatives, which would double-negate
    // the moment anything else summed the column.
    if (invoice.status === InvoiceStatus.CREDIT_NOTE) {
      this.creditNoteCount += 1;
      this.creditNoteTaxable = this.creditNoteTaxable.plus(subtotal);
      this.creditNoteCgst = this.creditNoteCgst.plus(cgst);
      this.creditNoteSgst = this.creditNoteSgst.plus(sgst);
      this.creditNoteIgst = this.creditNoteIgst.plus(igst);
      this.creditNoteTax = this.creditNoteTax.plus(tax);

      this.creditNoteRows.push({
        // CDNR when the buyer is registered, CDNUR when they are not — the two
        // are separate tables on the form.
        section: isRegistered ? 'CDNR' : 'CDNUR',
        noteNumber: invoice.invoiceNumber,
        noteDate: invoice.invoiceDate,
        buyerGstin: invoice.buyerGstin,
        buyerName: invoice.buyerName,
        originalInvoiceNumber: invoice.creditNoteForNumber ?? null,
        placeOfSupply: pos,
        placeOfSupplyName:
          invoice.placeOfSupplyName || getStateName(pos) || 'Unspecified',
        reason: invoice.creditNoteReason ?? null,
        taxableValue: toMoney(subtotal),
        cgst: toMoney(cgst),
        sgst: toMoney(sgst),
        igst: toMoney(igst),
        noteValue: toMoney(grandTotal),
      });

      return;
    }

    // Reached only for a real invoice — the credit-note branch above returns.
    this.totalInvoices += 1;
    this.totalTaxable = this.totalTaxable.plus(subtotal);
    this.totalCgst = this.totalCgst.plus(cgst);
    this.totalSgst = this.totalSgst.plus(sgst);
    this.totalIgst = this.totalIgst.plus(igst);
    this.totalTax = this.totalTax.plus(tax);

    // `buyerGstin` is normalised at write time to "a valid GSTIN or null", so
    // truthiness here is a safe B2B test and matches the Prisma-side predicate
    // in buildInvoiceWhere (which cannot run a regex).
    if (isRegistered) {
      const existing = this.b2b.get(invoice.buyerGstin!) ?? {
        buyerName: invoice.buyerName,
        invoices: [],
        totalTaxable: ZERO,
        totalTax: ZERO,
      };

      existing.invoices.push({
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        // Place of supply travels on the invoice, not the buyer group: it varies
        // per invoice within one buyer, and it is a mandatory GSTR-1 field.
        placeOfSupply: invoice.placeOfSupply,
        placeOfSupplyName: invoice.placeOfSupplyName,
        gstType: invoice.gstType,
        // The offline utility's B2B sheet carries this column, and it is what
        // separates table 4B (tax paid by the recipient) from 4A.
        reverseCharge: invoice.reverseCharge === true,
        subtotal: toMoney(subtotal),
        cgst: toMoney(cgst),
        sgst: toMoney(sgst),
        igst: toMoney(igst),
        totalTax: toMoney(tax),
        grandTotal: toMoney(grandTotal),
      });
      existing.totalTaxable = existing.totalTaxable.plus(subtotal);
      existing.totalTax = existing.totalTax.plus(tax);

      this.b2b.set(invoice.buyerGstin!, existing);
    } else {
      // Per-state roll-up (pre-Phase-2 shape, still rendered).
      const existing = this.b2c.get(pos) ?? {
        placeOfSupplyName: invoice.placeOfSupplyName,
        invoiceCount: 0,
        totalTaxable: ZERO,
        totalCgst: ZERO,
        totalSgst: ZERO,
        totalIgst: ZERO,
        totalTax: ZERO,
      };

      existing.invoiceCount += 1;
      existing.totalTaxable = existing.totalTaxable.plus(subtotal);
      existing.totalCgst = existing.totalCgst.plus(cgst);
      existing.totalSgst = existing.totalSgst.plus(sgst);
      existing.totalIgst = existing.totalIgst.plus(igst);
      existing.totalTax = existing.totalTax.plus(tax);

      this.b2c.set(pos, existing);

      // Table 5 vs Table 7. B2CL is inter-state only and compares the invoice
      // VALUE against the threshold; everything else summarises into B2CS.
      //
      // Both are RATE-WISE, which is why a B2C invoice must fold its line items
      // — the pre-Phase-2 code folded only invoice-level totals here, so a
      // single state row mixed every rate together and could not be filed.
      const isB2cl =
        isInterState && grandTotal.greaterThan(this.b2cLargeThreshold);

      for (const [rate, bucket] of this.rateBuckets(invoice)) {
        if (isB2cl) {
          this.b2cl.push({
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            placeOfSupply: pos,
            placeOfSupplyName:
              invoice.placeOfSupplyName || getStateName(pos) || 'Unspecified',
            gstRate: rate,
            taxableValue: toMoney(bucket.taxable),
            igst: toMoney(bucket.igst),
            invoiceValue: toMoney(grandTotal),
          });
          continue;
        }

        const key = `${pos}|${rate}`;
        const row = this.b2cs.get(key) ?? {
          placeOfSupply: pos,
          placeOfSupplyName: invoice.placeOfSupplyName,
          gstRate: rate,
          supplyType: isInterState ? ('INTER' as const) : ('INTRA' as const),
          taxable: ZERO,
          cgst: ZERO,
          sgst: ZERO,
          igst: ZERO,
        };

        row.taxable = row.taxable.plus(bucket.taxable);
        row.cgst = row.cgst.plus(bucket.cgst);
        row.sgst = row.sgst.plus(bucket.sgst);
        row.igst = row.igst.plus(bucket.igst);

        this.b2cs.set(key, row);
      }
    }

    // ── Line-level folds: Table 12 and Table 8 ──
    const nilKey = `${isInterState ? 'INTER' : 'INTRA'}|${isRegistered ? 'REG' : 'UNREG'}`;

    for (const item of invoice.lineItems ?? []) {
      const rate = dec(item.gstRate).toNumber();
      const taxable = dec(item.taxableValue);
      const lineCgst = dec(item.cgstAmount);
      const lineSgst = dec(item.sgstAmount);
      const lineIgst = dec(item.igstAmount);
      const lineTax = dec(item.totalTax);

      // Both null and the legacy '0000' mean "not classified".
      const rawHsn = item.hsnCode?.trim();
      const hsnCode = !rawHsn || rawHsn === '0000' ? null : rawHsn;
      if (!hsnCode) this.linesMissingHsn += 1;

      const uqc = item.unitOfMeasure?.trim() || 'NOS';

      // Table 12 is keyed by RECIPIENT TYPE and HSN AND rate AND unit — one
      // code sold at two rates is two statutory rows, and merging them produced
      // a row whose tax could not be derived from its taxable value. The
      // recipient type leads because the portal reports B2B and B2C as separate
      // tables, each reconciling to its own supplies.
      const recipientType: 'B2B' | 'B2C' = isRegistered ? 'B2B' : 'B2C';
      const hsnKey = `${recipientType}|${hsnCode ?? ''}|${uqc}|${rate}`;
      const row = this.hsn.get(hsnKey) ?? {
        recipientType,
        hsnCode,
        descriptions: new Map<string, Prisma.Decimal>(),
        descriptionOverflow: 0,
        uqc,
        gstRate: rate,
        quantity: 0,
        totalValue: ZERO,
        taxable: ZERO,
        cgst: ZERO,
        sgst: ZERO,
        igst: ZERO,
      };

      // Accumulate per description rather than keeping the first one seen.
      // Blank names are skipped so an unnamed line cannot win the row and
      // leave a statutory document describing its goods as nothing.
      const description = item.description?.trim();
      if (description) {
        const seen = row.descriptions.get(description);
        if (seen) {
          row.descriptions.set(description, seen.plus(taxable));
        } else if (row.descriptions.size < HSN_DESCRIPTION_CAP) {
          row.descriptions.set(description, taxable);
        } else {
          // Full. Keep the largest contributors rather than the earliest ones:
          // evict the smallest if this line beats it, so a dominant product
          // first seen AFTER the cap filled can still describe the row. Without
          // this the cap reintroduces the arrival-order bias this whole change
          // exists to remove. Only the displayed name is affected — the evicted
          // entry's value was never part of any total, so no money moves.
          row.descriptionOverflow += 1;

          let minKey: string | null = null;
          let minValue: Prisma.Decimal | null = null;
          for (const [candidate, value] of row.descriptions) {
            if (minValue === null || value.lessThan(minValue)) {
              minKey = candidate;
              minValue = value;
            }
          }

          if (minKey !== null && minValue !== null && taxable.greaterThan(minValue)) {
            row.descriptions.delete(minKey);
            row.descriptions.set(description, taxable);
          }
        }
      }

      row.quantity += item.quantity;
      row.taxable = row.taxable.plus(taxable);
      row.totalValue = row.totalValue.plus(taxable).plus(lineTax);
      row.cgst = row.cgst.plus(lineCgst);
      row.sgst = row.sgst.plus(lineSgst);
      row.igst = row.igst.plus(lineIgst);

      this.hsn.set(hsnKey, row);

      // Table 8 — supplies attracting no tax, split three ways. A ZERO_RATED
      // export belongs in GSTR-3B 3.1(b), not here, so it is excluded.
      if (item.supplyType === GstSupplyType.TAXABLE) continue;
      if (item.supplyType === GstSupplyType.ZERO_RATED) continue;

      const nil = this.nilRated.get(nilKey) ?? {
        nilRated: ZERO,
        exempted: ZERO,
        nonGst: ZERO,
      };

      if (item.supplyType === GstSupplyType.NIL_RATED) {
        nil.nilRated = nil.nilRated.plus(taxable);
      } else if (item.supplyType === GstSupplyType.EXEMPT) {
        nil.exempted = nil.exempted.plus(taxable);
      } else {
        nil.nonGst = nil.nonGst.plus(taxable);
      }

      this.nilRated.set(nilKey, nil);
    }
  }

  /**
   * Line items of one invoice, collapsed to per-rate buckets.
   *
   * B2CL and B2CS are both rate-wise, and an invoice can carry several rates,
   * so one invoice can contribute several rows to either table.
   */
  private rateBuckets(invoice: ReturnInvoice) {
    const buckets = new Map<
      number,
      {
        taxable: Prisma.Decimal;
        cgst: Prisma.Decimal;
        sgst: Prisma.Decimal;
        igst: Prisma.Decimal;
      }
    >();

    for (const item of invoice.lineItems ?? []) {
      const rate = dec(item.gstRate).toNumber();
      const bucket = buckets.get(rate) ?? {
        taxable: ZERO,
        cgst: ZERO,
        sgst: ZERO,
        igst: ZERO,
      };

      bucket.taxable = bucket.taxable.plus(dec(item.taxableValue));
      bucket.cgst = bucket.cgst.plus(dec(item.cgstAmount));
      bucket.sgst = bucket.sgst.plus(dec(item.sgstAmount));
      bucket.igst = bucket.igst.plus(dec(item.igstAmount));

      buckets.set(rate, bucket);
    }

    return Array.from(buckets.entries()).sort(([a], [b]) => a - b);
  }

  finish(): Gstr1Return {
    return {
      b2b: Array.from(this.b2b.entries()).map(([buyerGstin, entry]) => ({
        buyerGstin,
        buyerName: entry.buyerName,
        invoiceCount: entry.invoices.length,
        invoices: entry.invoices,
        totalTaxable: toMoney(entry.totalTaxable),
        totalTax: toMoney(entry.totalTax),
      })),
      b2cl: this.b2cl,
      b2cs: Array.from(this.b2cs.values())
        .map((row) => ({
          placeOfSupply: row.placeOfSupply,
          placeOfSupplyName:
            row.placeOfSupplyName ||
            getStateName(row.placeOfSupply) ||
            'Unspecified',
          gstRate: row.gstRate,
          supplyType: row.supplyType,
          taxableValue: toMoney(row.taxable),
          cgst: toMoney(row.cgst),
          sgst: toMoney(row.sgst),
          igst: toMoney(row.igst),
        }))
        .sort(
          (a, b) =>
            a.placeOfSupply.localeCompare(b.placeOfSupply) ||
            a.gstRate - b.gstRate,
        ),
      b2cSummary: Array.from(this.b2c.entries()).map(([code, entry]) => ({
        placeOfSupply: code,
        placeOfSupplyName:
          entry.placeOfSupplyName || getStateName(code) || 'Unspecified',
        invoiceCount: entry.invoiceCount,
        totalTaxable: toMoney(entry.totalTaxable),
        totalCgst: toMoney(entry.totalCgst),
        totalSgst: toMoney(entry.totalSgst),
        totalIgst: toMoney(entry.totalIgst),
        totalTax: toMoney(entry.totalTax),
      })),
      hsnSummary: Array.from(this.hsn.values())
        .map((row) => ({
          recipientType: row.recipientType,
          hsnCode: row.hsnCode,
          description: describeHsnGroup(row.descriptions, row.descriptionOverflow),
          uqc: row.uqc,
          gstRate: row.gstRate,
          quantity: row.quantity,
          totalValue: toMoney(row.totalValue),
          taxableValue: toMoney(row.taxable),
          cgst: toMoney(row.cgst),
          sgst: toMoney(row.sgst),
          igst: toMoney(row.igst),
        }))
        // B2B first, then by code, rate and unit. `uqc` is in the sort because
        // it is in the key: without it two rows differing only by unit kept
        // insertion order and the table read as unsorted.
        .sort(
          (a, b) =>
            a.recipientType.localeCompare(b.recipientType) ||
            (a.hsnCode ?? '').localeCompare(b.hsnCode ?? '') ||
            a.gstRate - b.gstRate ||
            a.uqc.localeCompare(b.uqc),
        ),
      // Emitted in statutory order, and only for rows that carry a value —
      // four permanently-zero rows would read as filed figures.
      nilRated: NIL_RATED_SECTIONS.flatMap((meta) => {
        const entry = this.nilRated.get(meta.key);
        if (!entry) return [];
        return [
          {
            section: meta.section,
            description: meta.description,
            nilRated: toMoney(entry.nilRated),
            exempted: toMoney(entry.exempted),
            nonGst: toMoney(entry.nonGst),
          },
        ];
      }),
      creditNotes: this.creditNoteRows,
      totals: {
        // NET of credit notes — this is what gets filed. A refunded sale that
        // stayed at its gross value was the single largest correctness gap in
        // this module.
        totalTaxable: toMoney(this.totalTaxable.minus(this.creditNoteTaxable)),
        totalCgst: toMoney(this.totalCgst.minus(this.creditNoteCgst)),
        totalSgst: toMoney(this.totalSgst.minus(this.creditNoteSgst)),
        totalIgst: toMoney(this.totalIgst.minus(this.creditNoteIgst)),
        totalTax: toMoney(this.totalTax.minus(this.creditNoteTax)),
        totalInvoices: this.totalInvoices,
        linesMissingHsn: this.linesMissingHsn,
        // Kept so the deduction is visible rather than implied, and so table 12
        // — which reports invoice LINES, not notes — remains reconcilable.
        grossTaxable: toMoney(this.totalTaxable),
        creditNoteCount: this.creditNoteCount,
        creditNoteTaxable: toMoney(this.creditNoteTaxable),
        creditNoteTax: toMoney(this.creditNoteTax),
      },
    };
  }
}

// ─── GSTR-3B ───

export class Gstr3bAccumulator {
  private readonly rates = new Map<
    number,
    {
      taxable: Prisma.Decimal;
      cgst: Prisma.Decimal;
      sgst: Prisma.Decimal;
      igst: Prisma.Decimal;
    }
  >();

  private readonly byState = new Map<
    string,
    {
      name: string | null;
      invoiceCount: number;
      taxable: Prisma.Decimal;
      igst: Prisma.Decimal;
    }
  >();

  private zeroRated = ZERO;
  private zeroRatedIgst = ZERO;
  private nilRatedExempt = ZERO;
  private nonGst = ZERO;

  private interStateCount = 0;
  private interStateTaxable = ZERO;
  private interStateIgst = ZERO;

  private payableCgst = ZERO;
  private payableSgst = ZERO;
  private payableIgst = ZERO;
  private payableTotal = ZERO;

  private rcmCount = 0;
  private rcmTaxable = ZERO;
  private rcmTax = ZERO;
  private rcmUnregistered = 0;

  addInvoice(invoice: ReturnInvoice): void {
    const subtotal = dec(invoice.subtotal);
    const igst = dec(invoice.totalIgst);

    // Outward supplies on which the RECIPIENT pays the tax.
    //
    // These belong in GSTR-1 table 4B, and the portal's system-computed
    // GSTR-3B builds 3.1(a) from 4A/4C/5/6C/7/9/10/11 — deliberately EXCLUDING
    // 4B, because the supplier owes nothing on them; the recipient declares
    // the same tax in their own 3.1(d). Leaving them in 3.1(a) and in tax
    // payable therefore declares tax twice across two returns and asks this
    // merchant to pay tax the law puts on someone else.
    //
    // They are reported separately instead, so the figure is visible rather
    // than silently dropped.
    const rcm = invoice.reverseCharge === true;

    // 3.1(a) and tax payable are reported NET of credit notes on the form, so a
    // credit note subtracts everywhere an invoice adds. `sign` keeps that in
    // one place rather than forking every accumulation below.
    const isCreditNote = invoice.status === InvoiceStatus.CREDIT_NOTE;
    const sign = isCreditNote ? -1 : 1;
    const signed = (value: Prisma.Decimal) =>
      isCreditNote ? value.negated() : value;

    if (!rcm) {
      this.payableCgst = this.payableCgst.plus(signed(dec(invoice.totalCgst)));
      this.payableSgst = this.payableSgst.plus(signed(dec(invoice.totalSgst)));
      this.payableIgst = this.payableIgst.plus(signed(igst));
      this.payableTotal = this.payableTotal.plus(signed(dec(invoice.totalTax)));
    }

    // The part of this invoice that actually lands in 3.1(a). Table 3.2 is a
    // memo OF 3.1(a), so it has to be built from the same subset rather than
    // from the invoice subtotal — otherwise an invoice whose lines are
    // zero-rated reports nothing in (a) but still shows up in 3.2.
    let taxableInA = ZERO;

    for (const item of invoice.lineItems ?? []) {
      const rate = dec(item.gstRate).toNumber();
      const taxable = dec(item.taxableValue);

      // 3.1(b), (c) and (e). Before Phase 2 nothing classified a supply, so
      // every line landed in (a) and these three were permanently empty —
      // which the panel's own comment admitted to the user.
      //
      // These rows are ALTERNATIVES to (a), not additions to it: the form
      // defines 3.1(a) as "outward taxable supplies (other than zero-rated,
      // nil-rated and exempted)". Classifying a line here therefore has to
      // stop it also being counted as a taxable supply below — which it did
      // not, so a zero-rated export was declared twice, once at 18% in (a)
      // and again as zero-rated in (b), overstating outward supplies by its
      // full value.
      let reportedOutsideA = false;
      switch (item.supplyType) {
        case GstSupplyType.ZERO_RATED:
          this.zeroRated = this.zeroRated.plus(signed(taxable));
          // Export on payment of IGST. Zero for an LUT export, which is the
          // usual case, so this row stays tax-free unless tax was charged.
          this.zeroRatedIgst = this.zeroRatedIgst.plus(signed(dec(item.igstAmount)));
          reportedOutsideA = true;
          break;
        case GstSupplyType.NIL_RATED:
        case GstSupplyType.EXEMPT:
          this.nilRatedExempt = this.nilRatedExempt.plus(signed(taxable));
          reportedOutsideA = true;
          break;
        case GstSupplyType.NON_GST:
          this.nonGst = this.nonGst.plus(signed(taxable));
          reportedOutsideA = true;
          break;
        default:
          break;
      }

      // The switch above stays UNGATED for reverse charge: a nil-rated or
      // exempt line carries no tax for anyone, so who would have paid it does
      // not change where it is reported. Only the taxable component moves.
      if (rcm) {
        if (item.supplyType === GstSupplyType.TAXABLE) {
          this.rcmTaxable = this.rcmTaxable.plus(signed(taxable));
        }
        continue;
      }

      // Already declared in (b), (c) or (e). Falling through to the rate
      // buckets below is what produced the double count.
      if (reportedOutsideA) continue;

      taxableInA = taxableInA.plus(taxable);

      const existing = this.rates.get(rate) ?? {
        taxable: ZERO,
        cgst: ZERO,
        sgst: ZERO,
        igst: ZERO,
      };

      existing.taxable = existing.taxable.plus(signed(taxable));
      existing.cgst = existing.cgst.plus(signed(dec(item.cgstAmount)));
      existing.sgst = existing.sgst.plus(signed(dec(item.sgstAmount)));
      existing.igst = existing.igst.plus(signed(dec(item.igstAmount)));

      this.rates.set(rate, existing);
    }

    if (rcm) {
      this.rcmCount += sign;
      this.rcmTax = this.rcmTax.plus(signed(dec(invoice.totalTax)));
      // An RCM supply to an unregistered buyer is almost certainly a
      // mis-flag — reverse charge on outward supplies runs B2B. Counted so
      // the UI can say so rather than guess.
      if (!invoice.buyerGstin) this.rcmUnregistered += sign;
      // 3.2 is a memo OF 3.1(a); a memo cannot report supplies its parent
      // excludes, so the inter-state aggregate is skipped too.
      return;
    }

    if (invoice.gstType !== GstType.IGST) return;

    // 3.2 is a memo OF 3.1(a), so an invoice contributing nothing to (a) —
    // a pure export, or an entirely nil-rated supply — contributes nothing
    // here either. Reporting it would put a supply in the memo that its
    // parent row does not contain.
    if (taxableInA.isZero()) return;

    // The aggregate spans EVERY inter-state invoice, net of credit notes, but
    // only the portion that reached 3.1(a) — `subtotal` would drag zero-rated
    // and exempt lines back in through the memo.
    this.interStateCount += sign;
    this.interStateTaxable = this.interStateTaxable.plus(signed(taxableInA));
    this.interStateIgst = this.interStateIgst.plus(signed(igst));

    // Table 3.2 is narrower: inter-state supplies to *unregistered* persons
    // only. The two are not interchangeable, and the CSV exporter used to write
    // the wider aggregate into the 3.2 row.
    if (invoice.buyerGstin) return;

    const key = posKey(invoice);
    const existing = this.byState.get(key) ?? {
      name: invoice.placeOfSupplyName,
      invoiceCount: 0,
      taxable: ZERO,
      igst: ZERO,
    };

    existing.invoiceCount += sign;
    // Same subset as the aggregate above — the per-state rows have to add up
    // to it, and both have to stay inside 3.1(a).
    existing.taxable = existing.taxable.plus(signed(taxableInA));
    existing.igst = existing.igst.plus(signed(igst));

    this.byState.set(key, existing);
  }

  finish(): Gstr3bReturn {
    return {
      outwardSupplies: Array.from(this.rates.entries())
        .sort(([a], [b]) => a - b)
        .map(([gstRate, data]) => ({
          gstRate,
          taxableValue: toMoney(data.taxable),
          cgst: toMoney(data.cgst),
          sgst: toMoney(data.sgst),
          igst: toMoney(data.igst),
          totalTax: toMoney(data.cgst.plus(data.sgst).plus(data.igst)),
        })),
      otherSupplies: {
        zeroRated: toMoney(this.zeroRated),
        zeroRatedIgst: toMoney(this.zeroRatedIgst),
        nilRatedExempt: toMoney(this.nilRatedExempt),
        nonGst: toMoney(this.nonGst),
      },
      interState: {
        invoiceCount: this.interStateCount,
        totalTaxable: toMoney(this.interStateTaxable),
        totalIgst: toMoney(this.interStateIgst),
        byState: Array.from(this.byState.entries())
          .map(([placeOfSupply, data]) => ({
            placeOfSupply,
            placeOfSupplyName:
              data.name || getStateName(placeOfSupply) || placeOfSupply,
            invoiceCount: data.invoiceCount,
            totalTaxable: toMoney(data.taxable),
            totalIgst: toMoney(data.igst),
          }))
          .sort((a, b) => b.totalTaxable - a.totalTaxable),
      },
      // Zeroed here and overwritten by `InvoiceService.getGstReturn` from the
      // period's recorded inward supplies. This class folds INVOICES, which are
      // outward; reverse charge is a purchase and has no business being
      // computed from a sales fold. Emitting the empty shape keeps the payload
      // one object rather than making every caller merge two.
      reverseCharge: { taxableValue: 0, igst: 0, entriesWithUnknownTax: 0 },
      outwardReverseCharge: {
        invoiceCount: this.rcmCount,
        taxableValue: toMoney(this.rcmTaxable),
        tax: toMoney(this.rcmTax),
        unregisteredRecipients: this.rcmUnregistered,
      },
      taxPayable: {
        cgst: toMoney(this.payableCgst),
        sgst: toMoney(this.payableSgst),
        igst: toMoney(this.payableIgst),
        total: toMoney(this.payableTotal),
      },
    };
  }
}
