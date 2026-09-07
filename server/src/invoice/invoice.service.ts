import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  GstSupplyType,
  GstType,
  InvoiceStatus,
  OrderFinancialStatus,
  Prisma,
} from '@prisma/client';
import {
  retryOnNumberingConflict,
  uniqueViolationTargets,
} from '../common/utils/serialization-retry.util';
import { PrismaService } from '../prisma/prisma.service';
import { GstService } from '../gst/gst.service';
import {
  GstCalculatorService,
  GstCalculationResult,
} from '../gst/gst-calculator.service';
import { normalizeGstin } from '../gst/constants/gst-rates';
import { resolveLineTaxClassification } from '../gst/line-tax-classification.util';
import { apportionShipping } from '../gst/shipping-apportionment.util';
import { parseTaxSettings } from '../organization-settings/schemas/tax-settings.schema';
import { parseOrderSettings } from '../organization-settings/schemas/order-settings.schema';
import { compareTax } from '../gst/tax-reconciliation.util';
import {
  EXPORT_PLACE_OF_SUPPLY,
  formatPlaceOfSupply,
  getStateName,
  isValidStateCode,
} from '../gst/constants/indian-states';
import {
  extractStateFromAddress,
  resolvePlaceOfSupply,
} from '../gst/place-of-supply.util';
import {
  getFinancialYear,
  gstQuarterForMonth,
  gstPeriodRange,
  INDIA_TZ,
  resolveGstTimeZone,
  zonedDayEndExclusive,
  zonedDayStart,
  zonedParts,
} from '../common/utils/zoned-date.util';
import {
  Gstr1Accumulator,
  Gstr3bAccumulator,
  type Gstr1Return,
  type Gstr3bReturn,
  type ReturnInvoice,
} from './gst-return.accumulator';
import { summarizeDocumentSeries } from './document-series.util';
import {
  buildGstr1Sections,
  buildGstr3bSections,
  type CsvSection,
} from './gst-return-rows';

/**
 * Hard ceiling on rows an export may materialise. Exports build the whole
 * result set in memory before serialising, so an unbounded query on a large
 * tenant is an out-of-memory risk for every tenant on the instance.
 */
const EXPORT_ROW_CAP = 10_000;

/**
 * Page size and hard ceiling for a GST RETURN.
 *
 * Deliberately separate from EXPORT_ROW_CAP, which truncates a *convenience*
 * export of the on-screen invoice list. A statutory return may never truncate:
 * past the ceiling it throws, naming the real count, rather than quietly filing
 * a subset.
 */
const GST_RETURN_PAGE_SIZE = 1_000;
const GST_RETURN_INVOICE_CAP = 50_000;

/**
 * The HSN placeholder this codebase used to invent when a product had none.
 *
 * Not a valid HSN, and it was written onto issued invoices — which are
 * statutory snapshots, so those rows are deliberately NOT rewritten. New lines
 * store null instead; both forms must read as "missing".
 */
const LEGACY_PLACEHOLDER_HSN = '0000';

/**
 * Organizations already warned about running GST on an untouched UTC timezone.
 * Process-local and deliberately unbounded-in-practice (one entry per org) —
 * the point is to surface the misconfiguration once, not once per invoice.
 */
const gstTimeZoneFallbackWarned = new Set<string>();

/**
 * Order payment states that leave money outstanding on an issued invoice.
 * `REFUNDED` and `VOIDED` are deliberately absent — nothing is owed on either,
 * so neither should count towards "Outstanding".
 */
const OUTSTANDING_FINANCIAL_STATES: OrderFinancialStatus[] = [
  OrderFinancialStatus.PENDING,
  OrderFinancialStatus.AUTHORIZED,
  OrderFinancialStatus.PARTIALLY_PAID,
];
import { TaxResolverService } from '../gst/tax-resolver.service';
import { InvoiceNumberService } from './invoice-number.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import {
  InvoiceSortField,
  InvoiceSortOrder,
  QueryInvoicesDto,
} from './dto/query-invoices.dto';
import { QueryGstReturnDto, GstReturnType } from './dto/query-gst-return.dto';
import { QueryInvoiceStatsDto } from './dto/query-invoice-stats.dto';
import { CreateCreditNoteDto } from './dto/create-credit-note.dto';
import { MarkFiledDto } from './dto/mark-filed.dto';

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gstService: GstService,
    private readonly calculator: GstCalculatorService,
    private readonly taxResolver: TaxResolverService,
    private readonly invoiceNumber: InvoiceNumberService,
  ) {}

  // ─── GENERATE INVOICE ───
  // Creates a GST-compliant invoice for an order.
  // Snapshots all seller/buyer data at creation time.
  // Serializable + bounded retry: invoice numbers are read-max-then-increment,
  // so two concurrent requests can compute the same number. The loser's
  // transaction rolls back (consuming no number — the sequence stays gapless)
  // and the retry re-reads the new max.
  async create(orgId: string, dto: CreateInvoiceDto) {
    return retryOnNumberingConflict(
      () =>
        this.prisma.$transaction(
          (tx) => this.createForOrderTx(tx, orgId, dto.orderId, dto),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10000,
          },
        ),
      {
        isRetriableUniqueViolation: (e) =>
          uniqueViolationTargets(e, 'invoiceNumber'),
        onRetry: (attempt) =>
          this.logger.warn(
            `Invoice number collision on attempt ${attempt} — retrying`,
          ),
      },
    );
  }

  /**
   * Issue an invoice for an order that has just reached PAID, if the org opted
   * in via `orderSettings.autoInvoiceOnPayment`.
   *
   * Shared by every path that can move an order to PAID — the Shopify webhook,
   * and the CRM's own Mark-as-paid and Capture actions. Those two used to
   * write PAID locally and stop there; the reconciling webhook then saw
   * PAID → PAID, `becamePaid` returned false, and the order was never
   * invoiced. Paying an order inside the CRM silently produced no invoice.
   *
   * Never throws. Invoicing must not be able to break the thing that triggered
   * it — a failed webhook is redelivered and would re-run the whole upsert,
   * and a failed capture would leave money taken with an error on screen.
   */
  async autoInvoiceForPaidOrder(orgId: string, orderId: string): Promise<void> {
    try {
      // Read the flag off the column directly, as the tax settings are read
      // elsewhere in this file — no extra injection, and it cannot see a value
      // some surrounding transaction has not committed.
      const settingsRow = await this.prisma.organizationSettings.findUnique({
        where: { organizationId: orgId },
        select: { orderSettings: true },
      });
      if (!parseOrderSettings(settingsRow?.orderSettings ?? null).autoInvoiceOnPayment) {
        return;
      }

      const invoice = await this.create(orgId, { orderId } as CreateInvoiceDto);
      this.logger.log(
        `Auto-issued invoice ${invoice.invoiceNumber} for paid order ${orderId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Auto-invoice skipped for paid order ${orderId}: ${message}`);
      await this.recordAutoInvoiceFailure(orgId, orderId, message);
    }
  }

  /**
   * Record why auto-invoicing did not issue a document — unless it turns out
   * the order already has one.
   *
   * Redelivered and concurrent webhooks both reach `create` for the same
   * order; the second is rejected with "Invoice … already exists", which is
   * the guard working, not a failure. Storing that message stamped a
   * frightening error on a perfectly invoiced order, and nothing ever cleared
   * it: the clear lives inside a SUCCESSFUL issue, so an error recorded after
   * the invoice existed was permanent. It also counted towards the uninvoiced
   * banner. Treat "already invoiced" as the success it is.
   */
  private async recordAutoInvoiceFailure(
    orgId: string,
    orderId: string,
    message: string,
  ): Promise<void> {
    try {
      const live = await this.prisma.invoice.findFirst({
        where: {
          orderId,
          organizationId: orgId,
          status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] },
        },
        select: { id: true },
      });

      if (live) {
        await this.prisma.order.updateMany({
          where: { id: orderId, organizationId: orgId, invoiceError: { not: null } },
          data: { invoiceError: null, invoiceErrorAt: null },
        });
        return;
      }

      await this.prisma.order.updateMany({
        where: { id: orderId, organizationId: orgId },
        data: { invoiceError: message.slice(0, 500), invoiceErrorAt: new Date() },
      });
    } catch (bookkeepingErr) {
      // Bookkeeping must never be the thing that breaks ingestion.
      this.logger.error(
        `Could not record auto-invoice outcome for order ${orderId}`,
        bookkeepingErr instanceof Error ? bookkeepingErr.stack : undefined,
      );
    }
  }

  /**
   * Transaction-scoped invoice creation. Used by:
   *   - the public `create()` (which opens its own tx)
   *   - the offline-order flow (which already holds an outer tx)
   *
   * Caller is responsible for verifying the org owns the order. We re-validate
   * defensively here to keep this safe to expose.
   */
  async createForOrderTx(
    tx: Prisma.TransactionClient,
    orgId: string,
    orderId: string,
    dto: {
      sellerGstinId?: string;
      buyerGstin?: string;
      placeOfSupplyCode?: string;
      notes?: string;
      reverseCharge?: boolean;
      dispatchWarehouseId?: string;
    },
  ) {
    // 1. Fetch the order with line items and customer
    const order = await tx.order.findFirst({
      // deletedAt filter matches every other order read path — without it a
      // soft-deleted order could still be issued a fresh, numbered, statutory
      // invoice.
      where: { id: orderId, organizationId: orgId, deletedAt: null },
      include: {
        lineItems: {
          include: {
            variant: {
              include: {
                product: {
                  select: {
                    id: true,
                    hsnCode: true,
                    gstRate: true,
                    // Phase 2: statutory classification and unit of quantity.
                    supplyType: true,
                    unitOfMeasure: true,
                  },
                },
              },
            },
          },
        },
        customer: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // 1b. One live invoice per order. Friendly guard for the common case; the
    // partial unique index invoices_order_id_active_key backstops the race
    // where two requests pass this check simultaneously (loser gets P2002 →
    // 409 via the global filter). Cancelled invoices don't count — cancel-
    // then-reissue is the statutory correction flow.
    // `organizationId` is redundant today — the order was verified org-owned at
    // the read above — but the 409 below quotes the invoice NUMBER back to the
    // caller, so an unscoped read here is one deleted line away from leaking a
    // different tenant's invoice number.
    const existingInvoice = await tx.invoice.findFirst({
      where: {
        orderId,
        organizationId: orgId,
        status: { not: InvoiceStatus.CANCELLED },
      },
      select: { invoiceNumber: true },
    });
    if (existingInvoice) {
      throw new ConflictException(
        `Invoice ${existingInvoice.invoiceNumber} already exists for this order. Cancel it first to issue a corrected one.`,
      );
    }

    // 2. Check if GST is enabled for the org. `timezone` is needed for the
    //    financial-year stamp below — servers run UTC, so deriving the FY in
    //    server-local time files a 00:30 IST sale on 1 April into the PREVIOUS
    //    financial year and burns a serial from that (possibly filed) year.
    const org = await tx.organization.findUnique({
      where: { id: orgId },
      select: { gstEnabled: true, timezone: true },
    });

    // B2CL threshold and the default UQC. Read in-transaction rather than via
    // OrganizationSettingsService so this needs no new injection and cannot see
    // a settings value the surrounding transaction did not.
    const settingsRow = await tx.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { taxSettings: true },
    });
    const taxSettings = parseTaxSettings(settingsRow?.taxSettings ?? null);

    if (!org?.gstEnabled) {
      throw new BadRequestException(
        'GST is not enabled for this organization. Enable it in Settings → Tax & GST.',
      );
    }

    // 3. Determine the seller GSTIN
    let sellerGstin;
    if (dto.sellerGstinId) {
      sellerGstin = await tx.organizationGstin.findFirst({
        where: { id: dto.sellerGstinId, organizationId: orgId },
      });
    } else {
      // Auto-select: try matching place of supply first, then default
      const placeOfSupply = this.resolvePlaceOfSupply(dto, order);
      sellerGstin = await tx.organizationGstin.findFirst({
        where: { organizationId: orgId, stateCode: placeOfSupply, isActive: true },
      });
      if (!sellerGstin) {
        sellerGstin = await tx.organizationGstin.findFirst({
          where: { organizationId: orgId, isDefault: true, isActive: true },
        });
      }
    }

    if (!sellerGstin) {
      throw new BadRequestException(
        'No GSTIN registration found. Please add a GSTIN in Settings → Tax & GST.',
      );
    }

    // 3b. Resolve where the goods left from, for the "Dispatch From" snapshot.
    const dispatchWarehouse = await this.resolveDispatchWarehouse(
      tx,
      orgId,
      dto.dispatchWarehouseId,
      order.dispatchWarehouseId,
      sellerGstin.id,
    );

    // 4. Determine place of supply. Prefers the code the order was taxed with;
    //    the seller's state is the over-the-counter fallback for walk-ins.
    const placeOfSupplyCode = this.resolvePlaceOfSupply(
      dto,
      order,
      sellerGstin.stateCode,
    );
    const placeOfSupplyName =
      getStateName(placeOfSupplyCode) || placeOfSupplyCode;

    // An export is zero-rated by destination, so this is derived here rather
    // than configured on the product.
    const isExportSupply = placeOfSupplyCode === EXPORT_PLACE_OF_SUPPLY;

    // 5. Determine GST type (intra vs inter state)
    const isIntraState = this.calculator.isIntraState(
      sellerGstin.stateCode,
      placeOfSupplyCode,
    );
    const gstType = isIntraState ? GstType.CGST_SGST : GstType.IGST;

    // 6. Calculate tax for each line item
    const lineItemResults: Array<{
      orderLineItem: (typeof order.lineItems)[0];
      calculation: GstCalculationResult;
      hsnCode: string | null;
      unitOfMeasure: string;
      supplyType: GstSupplyType;
    }> = [];

    // Rates for EVERY line in at most four queries, run on this transaction.
    //
    // This was a per-line `resolveLineGstRate` call issuing up to four queries
    // each, on `this.prisma` rather than `tx` — so a 20-line invoice made ~80
    // sequential round trips AND took a second pooled connection per line while
    // this transaction held the first. The priority chain is unchanged;
    // toNullableNumber still preserves null (unset) vs 0 (explicitly exempt),
    // and the taxable flags still short-circuit to 0%.
    // Classification is resolved BEFORE the rates, because it decides whether
    // a rate applies at all. It used to run afterwards, inside the loop below,
    // so `resolveLineGstRates` never learned that an export line is ZERO_RATED
    // and handed it the goods' ordinary rate — invoice INV-26-27/000007 was
    // raised with ₹266.38 of IGST on a supply the sales channel had charged
    // nothing for. Under an LUT an export is zero-rated without payment of tax.
    //
    // HSN / UQC / supply type resolve variant → product → fallback, field by
    // field. HSN is NULL, never the invented '0000', when nobody classified
    // the goods — `hsnMissing` below makes that visible before filing. UQC
    // falls back to the org default so Table 12 always has a unit.
    // ZERO_RATED is DERIVED from an export place of supply and cannot be
    // overridden by either side.
    const lineClassifications = order.lineItems.map((item) =>
      resolveLineTaxClassification({
        variant: item.variant,
        product: item.variant?.product,
        defaultUnitOfMeasure: taxSettings.defaultUnitOfMeasure,
        isExportSupply,
      }),
    );

    const lineGstRates = await this.taxResolver.resolveLineGstRates(
      orgId,
      placeOfSupplyCode,
      order.lineItems.map((item, index) => ({
        productId: item.variant?.product?.id ?? null,
        // A variant classified differently from its product carries its own
        // rate; null on the variant means "same as the product".
        variantGstRate: this.calculator.toNullableNumber(item.variant?.gstRate),
        productGstRate: this.calculator.toNullableNumber(
          item.variant?.product?.gstRate,
        ),
        lineTaxable: item.taxable,
        variantTaxable: item.variant?.taxable,
        supplyType: lineClassifications[index].supplyType,
      })),
      tx,
    );

    for (const [index, item] of order.lineItems.entries()) {
      const gstRate = lineGstRates[index];
      // Resolved above, before the rates — see the note there.
      const { hsnCode, unitOfMeasure, supplyType } = lineClassifications[index];

      const calculation = this.calculator.calculateLineItem(
        {
          unitPrice: this.calculator.toNumber(item.price),
          quantity: item.quantity,
          discount: this.calculator.toNumber(item.totalDiscount),
          gstRate,
        },
        isIntraState,
      );

      lineItemResults.push({
        orderLineItem: item,
        calculation,
        hsnCode,
        unitOfMeasure,
        supplyType,
      });
    }

    // 6b. Shipping as a COMPOSITE SUPPLY, when the org has opted in.
    //
    // Delivery charged on a taxable supply normally takes the goods' rate under
    // Indian GST. Until now shipping was added to the grand total untaxed, so
    // every shipped order under-declared output tax and shipping revenue never
    // reached GSTR-3B 3.1(a) at all.
    //
    // The charge is apportioned across TAXABLE lines only and folded into their
    // taxable values, so it flows into the rate buckets, table 12 and the HSN
    // summary automatically rather than needing a parallel code path.
    const shippingAmount = this.calculator.toNumber(order.totalShippingPrice);
    const taxShipping = taxSettings.taxShipping && shippingAmount > 0;

    if (taxShipping) {
      const shares = apportionShipping(
        lineItemResults.map((r) => ({
          taxableValue: r.calculation.taxableValue,
          // A zero-RATE line is still a taxable supply; an exempt or non-GST one
          // is not, and must not acquire tax through its share of delivery.
          taxable: r.supplyType === GstSupplyType.TAXABLE,
        })),
        shippingAmount,
      );

      lineItemResults.forEach((r, i) => {
        if (!shares[i]) return;
        // Recompute from the augmented base so CGST/SGST/IGST all move together
        // rather than being patched individually.
        r.calculation = this.calculator.calculateLineItem(
          {
            unitPrice: r.calculation.taxableValue + shares[i],
            quantity: 1,
            discount: 0,
            gstRate: r.calculation.gstRate,
          },
          isIntraState,
        );
      });
    }

    // 7. Calculate invoice totals.
    //    The discount reported is the sum of the discounts ACTUALLY applied to
    //    these lines — each is already subtracted inside `taxableValue`, so it
    //    must not be deducted again. Using `order.totalDiscounts` here would
    //    print 0.00 on every offline invoice (that column is hardcoded 0) and
    //    would double-count on Shopify orders (it already includes the per-line
    //    allocations). Shipping is carried through so the invoice total agrees
    //    with the order total.
    const calculations = lineItemResults.map((r) => r.calculation);
    const appliedDiscount = this.calculator.round2(
      lineItemResults.reduce(
        (sum, r) => sum + this.calculator.toNumber(r.orderLineItem.totalDiscount),
        0,
      ),
    );
    const totals = this.calculator.calculateInvoiceTotals(
      calculations,
      appliedDiscount,
      // Zero when shipping was apportioned: it is already inside the line
      // taxable values, and adding it again would double-count it in the grand
      // total. `shippingCharge` is still persisted for the totals ladder.
      taxShipping ? 0 : shippingAmount,
    );

    // 7b. Reconcile what the SALES CHANNEL charged against what this invoice

    //     declares. The CRM recomputes tax independently of Shopify, and

    //     nothing ever compared the two — so a merchant whose Shopify tax

    //     config had drifted from their CRM config filed a number that did not

    //     match the money they took, with no signal anywhere.

    //

    //     This changes NOTHING about the invoice's value. `totals` is still

    //     authoritative; the comparison only records the divergence so the

    //     filing tab can warn BEFORE the return goes out.

    const taxComparison = compareTax(order.totalTax, totals.totalTax);

    if (taxComparison.mismatch) {

        this.logger.warn(

            `Order ${order.id}: channel charged ${taxComparison.chargedTax?.toString()} tax ` +

            `but invoice declares ${taxComparison.declaredTax.toString()} ` +

            `(delta ${taxComparison.delta?.toString()}). Check the GST rate configuration.`,

        );

    }

    

    // 8. Generate invoice number (passes the same tx so it's atomic with the create below)
    const invoiceDate = new Date();
    const financialYear = this.calculator.getFinancialYear(
      invoiceDate,
      this.gstTimeZone(orgId, org),
    );
    // A filed period is closed. Issuing into it would change a return that has
    // already gone to the government, with no amendment trail.
    await this.assertPeriodOpen(
      tx,
      orgId,
      invoiceDate,
      sellerGstin.id,
      this.gstTimeZone(orgId, org),
      'Issuing an invoice',
    );

    const invoiceNum = await this.invoiceNumber.getNextInvoiceNumber(
      orgId,
      financialYear,
      tx,
    );

    // 9. Resolve buyer info.
    //
    // NORMALISED AT WRITE TIME, not validated at read time. B2B/B2C is decided
    // by whether this column is null — and `buildInvoiceWhere` makes the same
    // decision in Prisma with `buyerGstin: { not: null }`, which cannot run a
    // regex. Validating only when generating the return would therefore make
    // the invoice LIST and the RETURN classify the same invoice differently.
    // Storing "a valid GSTIN or null" keeps both predicates equivalent.
    //
    // An explicit `dto.buyerGstin` is already @Matches(GSTIN_REGEX) in the DTO,
    // so it is rejected rather than silently dropped. A junk GSTIN on the
    // CUSTOMER record is different: it arrives from Shopify customer sync and
    // CSV import, neither of which validates, and must not block a legitimate
    // invoice — it just must not make the sale B2B.
    const customerGstin = normalizeGstin(order.customer?.gstin);
    if (order.customer?.gstin && !customerGstin) {
      this.logger.warn(
        `Customer ${order.customer.id} has an invalid GSTIN; invoicing order ` +
          `${order.id} as B2C. Correct it on the customer record to file this as B2B.`,
      );
    }

    const buyerGstin = normalizeGstin(dto.buyerGstin) || customerGstin || null;
    const buyerName = order.customer
      ? `${order.customer.firstName || ''} ${order.customer.lastName || ''}`.trim()
      : 'Guest Customer';
    const buyerStateCode =
      this.extractStateFromAddress(order.billingAddress) ||
      order.customer?.billingStateCode ||
      placeOfSupplyCode;
    const buyerStateName = getStateName(buyerStateCode) || buyerStateCode;

    // 10. Create the invoice with line items
    const invoice = await tx.invoice.create({
      data: {
        organizationId: orgId,
        orderId: order.id,
        sellerGstinId: sellerGstin.id,
        invoiceNumber: invoiceNum,
        invoiceDate,
        financialYear,
        // Seller snapshot
        sellerGstin: sellerGstin.gstin,
        sellerLegalName: sellerGstin.legalName,
        sellerAddress: sellerGstin.address ?? undefined,
        sellerStateCode: sellerGstin.stateCode,
        sellerStateName: sellerGstin.stateName,
        // Dispatch-from snapshot (additional place of business). All null when
        // the goods left from the registered address, or the org does not use
        // warehousing — the print and detail views render nothing in that case.
        dispatchWarehouseId: dispatchWarehouse?.id ?? null,
        dispatchName: dispatchWarehouse?.name ?? null,
        dispatchAddress:
          (dispatchWarehouse?.address as Prisma.InputJsonValue | undefined) ?? undefined,
        dispatchStateCode: dispatchWarehouse?.stateCode ?? null,
        // Buyer snapshot
        buyerName,
        buyerGstin,
        buyerAddress: order.billingAddress ?? undefined,
        buyerStateCode,
        buyerStateName,
        // Place of supply
        placeOfSupply: placeOfSupplyCode,
        placeOfSupplyName,
        gstType,
        // Totals
        subtotal: totals.subtotal,
        totalCgst: totals.totalCgst,
        totalSgst: totals.totalSgst,
        totalIgst: totals.totalIgst,
        totalTax: totals.totalTax,
        totalDiscount: totals.totalDiscount,
        // Persisted, not just folded into grandTotal. `calculateInvoiceTotals`
        // adds shipping to the grand total; storing the addend is what lets the
        // detail dialog, the printed invoice and the CSV show a totals ladder
        // that actually sums to `grandTotal`.
        shippingCharge: this.calculator.toNumber(order.totalShippingPrice),
        // Reconciliation snapshot. `chargedTax: null` reads as "never compared",
        // which is not the same as "compared and equal".
        // Counts BOTH a null and the legacy '0000' as missing, because issued
        // invoices carrying '0000' were deliberately not rewritten.
        hsnMissing: lineItemResults.some(
          (r) => !r.hsnCode || r.hsnCode === LEGACY_PLACEHOLDER_HSN,
        ),
        chargedTax: taxComparison.chargedTax,
        taxMismatchDelta: taxComparison.delta,
        taxMismatch: taxComparison.mismatch,
        grandTotal: totals.grandTotal,
        currency: order.currency,
        notes: dto.notes,
        // Rule 46(p): the invoice must declare this. False is the correct and
        // required answer for an ordinary forward-charge supply — the point is
        // that it can now also be true.
        reverseCharge: dto.reverseCharge ?? false,
        // Line items
        lineItems: {
          create: lineItemResults.map((r) => ({
            orderLineItemId: r.orderLineItem.id,
            description: r.orderLineItem.variantTitle
              ? `${r.orderLineItem.title} - ${r.orderLineItem.variantTitle}`
              : r.orderLineItem.title,
            hsnCode: r.hsnCode,
            unitOfMeasure: r.unitOfMeasure,
            supplyType: r.supplyType,
            quantity: r.orderLineItem.quantity,
            // The gross per-unit price. (This previously read as
            // `taxable/qty + taxable === 0 ? 0 : price` — `+` and `===` bind
            // tighter than `?:`, so the division was computed and discarded and
            // a fully-discounted line was written with unitPrice 0 while
            // `discount` still held the full amount, breaking the row's own
            // invariant taxableValue = unitPrice*qty - discount.)
            unitPrice: this.calculator.toNumber(r.orderLineItem.price),
            discount: this.calculator.toNumber(r.orderLineItem.totalDiscount),
            taxableValue: r.calculation.taxableValue,
            gstRate: r.calculation.gstRate,
            cgstRate: r.calculation.cgstRate,
            cgstAmount: r.calculation.cgstAmount,
            sgstRate: r.calculation.sgstRate,
            sgstAmount: r.calculation.sgstAmount,
            igstRate: r.calculation.igstRate,
            igstAmount: r.calculation.igstAmount,
            totalTax: r.calculation.totalTax,
            totalAmount: r.calculation.totalAmount,
          })),
        },
      },
      include: { lineItems: true },
    });

    // Any successful issue clears a recorded auto-invoicing failure, including
    // a manual reissue after the merchant fixed their GST settings — so the
    // "uninvoiced paid orders" count on the filing tab repairs itself rather
    // than needing to be dismissed. Inside the same transaction as the invoice,
    // so the flag can never survive the invoice that resolves it.
    await tx.order.updateMany({
      where: { id: order.id, organizationId: orgId, invoiceError: { not: null } },
      data: { invoiceError: null, invoiceErrorAt: null },
    });

    return invoice;
  }

  /**
   * The list `where`, shared by `findAll` and `getExportData`.
   *
   * Extracted because the export used to build its own, much narrower filter —
   * it honoured only financialYear / status / sellerGstinId and silently dropped
   * search, the date range, buyerType and paymentState. The Export CSV button
   * sits directly beside the filtered table and hands it exactly those params,
   * so the downloaded file was a different set of invoices from the one on
   * screen. One builder, one meaning.
   */
  private buildInvoiceWhere(
    orgId: string,
    query: QueryInvoicesDto,
    timeZone: string,
  ): Prisma.InvoiceWhereInput {
    return {
      organizationId: orgId,
      ...(query.financialYear && { financialYear: query.financialYear }),
      ...(query.status && { status: query.status }),
      ...(query.sellerGstinId && { sellerGstinId: query.sellerGstinId }),
      // B2B/B2C is not a stored column — a buyer is registered exactly when the
      // invoice captured a GSTIN for them.
      ...(query.buyerType === 'B2B' && { buyerGstin: { not: null } }),
      ...(query.buyerType === 'B2C' && { buyerGstin: null }),
      // "Unpaid" means issued AND the order still owes. The status is pinned
      // here rather than left to `query.status` so the filter cannot be
      // combined into something self-contradictory (a cancelled-but-unpaid
      // invoice is not a thing the UI should be able to ask for).
      ...(query.paymentState === 'UNPAID' && {
        status: InvoiceStatus.ISSUED,
        order: { financialStatus: { in: OUTSTANDING_FINANCIAL_STATES } },
      }),
      ...(query.search && {
        OR: [
          { invoiceNumber: { contains: query.search, mode: 'insensitive' } },
          { buyerName: { contains: query.search, mode: 'insensitive' } },
          { buyerGstin: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
      // `lt` on an exclusive next-day bound, not `lte` on the day itself: a
      // bare "2026-04-30" parsed as an instant is that day's FIRST moment, so
      // an inclusive bound excluded almost the whole day the user asked for.
      ...(query.dateFrom || query.dateTo
        ? {
            invoiceDate: {
              ...(query.dateFrom && {
                gte: zonedDayStart(query.dateFrom, timeZone),
              }),
              ...(query.dateTo && {
                lt: zonedDayEndExclusive(query.dateTo, timeZone),
              }),
            },
          }
        : {}),
    };
  }

  /**
   * Timezone for the list/export date filters.
   *
   * Date filters name calendar days in the merchant's timezone, so they resolve
   * it the same way the statutory date math does — otherwise the list disagrees
   * with the GST return sitting next to it. Skipped entirely when no date
   * filter is present, so an ordinary page load does not pay for an extra
   * organization read.
   */
  private async listTimeZone(
    orgId: string,
    query: QueryInvoicesDto,
  ): Promise<string> {
    if (!query.dateFrom && !query.dateTo) return 'UTC';

    return this.gstTimeZone(
      orgId,
      await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { timezone: true, gstEnabled: true },
      }),
    );
  }

  /**
   * Sort order for the list and the export.
   *
   * `sortBy` is an enum on the DTO, so an unknown column cannot reach Prisma
   * here — see the note on `InvoiceSortField`.
   */
  private buildInvoiceOrderBy(
    query: QueryInvoicesDto,
  ): Prisma.InvoiceOrderByWithRelationInput {
    const field = query.sortBy ?? InvoiceSortField.invoiceDate;
    const direction = query.sortOrder ?? InvoiceSortOrder.desc;
    return { [field]: direction };
  }

  // ─── LIST INVOICES ───
  async findAll(orgId: string, query: QueryInvoicesDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where = this.buildInvoiceWhere(
      orgId,
      query,
      await this.listTimeZone(orgId, query),
    );

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: this.buildInvoiceOrderBy(query),
        include: {
          // `financialStatus` backs the derived "Unpaid" pill in the list — the
          // invoice itself has no payment state. `id` lets the row link through
          // to the order the invoice was raised against.
          order: {
            select: {
              id: true,
              name: true,
              orderNumber: true,
              financialStatus: true,
            },
          },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─── GET SINGLE INVOICE ───
  async findOne(id: string, orgId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId: orgId },
      include: {
        lineItems: true,
        // `id` is required: the detail dialog links through to the order.
        // Keep this select in step with `findAll`'s — the client shares one
        // `Invoice.order` type across the list row and the detail view.
        order: {
          select: {
            id: true,
            name: true,
            orderNumber: true,
            financialStatus: true,
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    return invoice;
  }

  // ─── CANCEL INVOICE ───
  /**
   * Cancel an issued invoice, as an atomic org-scoped claim.
   *
   * This was read-then-write: `findOne(id, orgId)` for the guard, then
   * `update({ where: { id } })` — a bare-id write whose tenant safety rested
   * entirely on the line above it, plus a check-then-act window in which two
   * concurrent cancels both passed the guard and the loser overwrote
   * `cancelledAt` with a later timestamp than the one that actually cancelled
   * it. Same shape of fix as `OrderService.cancel`: let the WHERE clause carry
   * the precondition, then interpret a zero count.
   */
  async cancel(id: string, orgId: string) {
    // Cancelling makes an invoice VANISH from a regenerated return. That is an
    // acceptable same-period correction, but once the period is filed it
    // silently contradicts what was already declared — the statutory remedy is
    // a credit note, which is additive and leaves a trail.
    const target = await this.prisma.invoice.findFirst({
      where: { id, organizationId: orgId },
      // sellerGstinId: the lock is per registration, so it has to be read here.
      select: { invoiceDate: true, status: true, sellerGstinId: true },
    });
    if (target && target.status !== InvoiceStatus.CANCELLED) {
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { timezone: true, gstEnabled: true },
      });
      await this.assertPeriodOpen(
        this.prisma,
        orgId,
        target.invoiceDate,
        target.sellerGstinId,
        this.gstTimeZone(orgId, org),
        'Cancelling this invoice',
      );
    }

    const claimed = await this.prisma.invoice.updateMany({
      where: {
        id,
        organizationId: orgId,
        status: { not: InvoiceStatus.CANCELLED },
      },
      data: {
        status: InvoiceStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      // Zero rows means one of two very different things. Distinguish them so
      // a cross-tenant id still 404s rather than reporting the invoice as
      // already cancelled (which would confirm that it exists).
      const existing = await this.prisma.invoice.findFirst({
        where: { id, organizationId: orgId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Invoice not found');
      throw new ConflictException('Invoice is already cancelled');
    }

    return this.findOne(id, orgId);
  }


  // ─── FILING STATE ───
  /**
   * Refuse to change a period that has already been filed.
   *
   * Nothing recorded a filing before, so GSTR-1/3B were recomputed from
   * `invoices` on every request — issuing or cancelling an invoice inside an
   * already-filed month silently rewrote history with no amendment trail. The
   * statutory correction for a filed period is a credit note or an amendment,
   * never an edit.
   */
  private async assertPeriodOpen(
    client: Prisma.TransactionClient | PrismaService,
    orgId: string,
    invoiceDate: Date,
    sellerGstinId: string,
    timeZone: string,
    action: string,
  ): Promise<void> {
    const financialYear = getFinancialYear(invoiceDate, timeZone);
    const month = String(zonedParts(invoiceDate, timeZone).month).padStart(2, '0');

    const filing = await client.gstFiling.findFirst({
      where: {
        organizationId: orgId,
        financialYear,
        // A quarterly filer records the period as "Q1", while every document is
        // dated to a MONTH. Matching only the month meant a quarterly filing
        // locked nothing at all — the row existed and was never consulted.
        period: { in: [month, gstQuarterForMonth(month)] },
        // A filing covers ONE registration. Locking a Karnataka document
        // because the Maharashtra return went in freezes a business that files
        // each state on its own schedule. A filing recorded against no
        // particular GSTIN (sellerGstinId null) covers them all.
        OR: [{ sellerGstinId: null }, { sellerGstinId }],
      },
      select: { returnType: true, period: true, filedAt: true, arn: true },
    });

    if (!filing) return;

    // returnType is deliberately NOT part of the predicate: whichever return
    // went in, the underlying documents for that period are now on record.
    throw new ConflictException(
      `${action} is not allowed: ${filing.returnType} for ${filing.period}/${financialYear} was ` +
        `filed on ${filing.filedAt.toISOString().split('T')[0]}` +
        `${filing.arn ? ` (ARN ${filing.arn})` : ''}. ` +
        `Raise a credit note instead — a filed period cannot be edited.`,
    );
  }

  /** Record that a period has been filed, locking it. */
  async markFiled(orgId: string, dto: MarkFiledDto, userId?: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true, gstEnabled: true },
    });

    // Canonicalised to upper case. GST_PERIOD_REGEX accepts "q1" as well as
    // "Q1", and a stored lower-case period would never match the lock's
    // `period IN (month, quarter)` predicate — the row would exist and lock
    // nothing, which is the worst of both outcomes.
    const period = dto.period.toUpperCase();

    // Snapshot what was filed, so a later recomputation can be COMPARED with
    // what actually went to the government rather than silently replacing it.
    const totals = (await this.getGstReturn(orgId, {
      financialYear: dto.financialYear,
      period,
      returnType: dto.returnType,
      sellerGstinId: dto.sellerGstinId,
      // Deliberately NOT warehouse-scoped: a filing covers a GSTIN's whole
      // period. MarkFiledDto carries no warehouse field for the same reason.
    })) as { totals?: unknown; taxPayable?: unknown };

    // findFirst + create/update rather than upsert: `sellerGstinId` is
    // nullable and Prisma's compound-unique `where` input will not accept null,
    // even though the SQL index is declared NULLS NOT DISTINCT and does treat
    // two nulls as the same row.
    const existing = await this.prisma.gstFiling.findFirst({
      where: {
        organizationId: orgId,
        financialYear: dto.financialYear,
        period,
        returnType: dto.returnType,
        sellerGstinId: dto.sellerGstinId ?? null,
      },
      select: { id: true },
    });

    if (existing) {
      // Re-filing REPLACES the snapshot, and re-stamps who filed and when.
      // Updating only the ARN left the stored figures describing an earlier
      // state of the period — so a merchant who corrected something and filed
      // again had a record that matched neither what they sent nor what the
      // system now holds.
      return this.prisma.gstFiling.update({
        where: { id: existing.id },
        data: {
          arn: dto.arn ?? null,
          filedAt: new Date(),
          filedById: userId ?? null,
          totals: (totals.totals ?? totals.taxPayable ?? {}) as Prisma.InputJsonValue,
        },
      });
    }

    return this.prisma.gstFiling.create({
      data: {
        organizationId: orgId,
        financialYear: dto.financialYear,
        period,
        returnType: dto.returnType,
        sellerGstinId: dto.sellerGstinId ?? null,
        filedById: userId ?? null,
        arn: dto.arn ?? null,
        totals: (totals.totals ?? totals.taxPayable ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /** Filed periods for the year, so the UI can show which are locked. */
  async listFilings(orgId: string, financialYear?: string) {
    return this.prisma.gstFiling.findMany({
      where: { organizationId: orgId, ...(financialYear && { financialYear }) },
      orderBy: [{ financialYear: 'desc' }, { period: 'desc' }],
    });
  }

  /**
   * Reopen a period filed in error.
   *
   * Deliberately present: a lock with no key turns a mistaken click into a
   * permanently unusable month. Role-gated like every other statutory action.
   */
  async unfile(orgId: string, id: string) {
    const deleted = await this.prisma.gstFiling.deleteMany({
      where: { id, organizationId: orgId },
    });
    if (deleted.count === 0) throw new NotFoundException('Filing not found');
    return { id, reopened: true };
  }

  /**
   * Refunded orders whose invoice has not been credited.
   *
   * Returns the ISSUED invoice alongside the refund totals, so the UI can
   * pre-fill a credit note instead of making someone re-key the amount off a
   * Shopify screen. `refundedTax` is NULL when the channel never told us —
   * the caller must show that as unknown rather than as zero, or the note would
   * reverse the sale value while reversing none of its tax.
   */
  async listRefundsNeedingCreditNote(orgId: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        refunds: { some: {} },
        invoices: { some: { status: InvoiceStatus.ISSUED } },
        // Deliberately NOT "has no credit note". An order part-credited once
        // is still under-credited if it is refunded again, and excluding it
        // here would drop it out of the warning permanently with money still
        // uncredited. Partial credits are netted in the fold below instead.
      },
      select: {
        id: true,
        name: true,
        currency: true,
        refunds: { select: { amount: true, totalTax: true, processedAt: true, reason: true } },
        invoices: {
          // Both statuses in ONE selection — a relation may appear only once —
          // then partitioned in the fold. At most one invoice per order can be
          // ISSUED (the active-invoice unique index guarantees it), so there is
          // no ambiguity about which invoice the notes reverse.
          where: { status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.CREDIT_NOTE] } },
          select: { id: true, invoiceNumber: true, grandTotal: true, totalTax: true, status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CAP,
    });

    return orders.flatMap((order) => {
      const invoice = order.invoices.find(
        (i) => i.status === InvoiceStatus.ISSUED,
      );
      if (!invoice) return [];

      const creditNotes = order.invoices.filter(
        (i) => i.status === InvoiceStatus.CREDIT_NOTE,
      );

      const refundedAmount = order.refunds.reduce(
        (sum, r) => sum.plus(new Prisma.Decimal(r.amount)),
        new Prisma.Decimal(0),
      );

      // All-or-nothing, matching `extractRefundTax`: if any refund on the order
      // has unknown tax, the order total is unknown rather than partial.
      const anyUnknown = order.refunds.some((r) => r.totalTax === null);
      const refundedTax = anyUnknown
        ? null
        : order.refunds.reduce(
            (sum, r) => sum.plus(new Prisma.Decimal(r.totalTax!)),
            new Prisma.Decimal(0),
          );

      // Credit notes store POSITIVE amounts, as on the paper document.
      const creditedAmount = creditNotes.reduce(
        (sum, cn) => sum.plus(new Prisma.Decimal(cn.grandTotal)),
        new Prisma.Decimal(0),
      );
      const creditedTax = creditNotes.reduce(
        (sum, cn) => sum.plus(new Prisma.Decimal(cn.totalTax)),
        new Prisma.Decimal(0),
      );

      // Fully credited — nothing to warn about. Strictly less-than, so an exact
      // match settles the order rather than leaving a zero-value row on screen.
      if (!creditedAmount.lessThan(refundedAmount)) return [];

      // What a credit note raised NOW should be for. Prefilling the gross
      // refund instead would be refused by createCreditNote as over-crediting
      // the moment any part of it had already been credited.
      const pendingAmount = refundedAmount.minus(creditedAmount);
      const pendingTax =
        refundedTax === null ? null : refundedTax.minus(creditedTax);

      return [
        {
          orderId: order.id,
          orderName: order.name,
          currency: order.currency,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceTotal: invoice.grandTotal,
          refundedAmount,
          refundedTax,
          creditedAmount,
          creditedTax,
          pendingAmount,
          pendingTax,
          refundCount: order.refunds.length,
          lastRefundAt:
            order.refunds
              .map((r) => r.processedAt)
              .filter((d): d is Date => !!d)
              .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
          reason: order.refunds.find((r) => r.reason)?.reason ?? null,
        },
      ];
    });
  }

  // ─── CREDIT NOTES ───
  /**
   * Raise a credit note against an issued invoice.
   *
   * WHY THIS EXISTS. Refunds had no GST treatment at all: a refunded sale
   * stayed 100% in declared output liability for ever, `InvoiceStatus.CREDIT_NOTE`
   * was dead code, and GSTR-1 had no Table 9B. Any merchant who accepts returns
   * has been over-declaring tax every month.
   *
   * A credit note reuses the `invoices` table — it is shaped like an invoice and
   * must fold into the same return — but carries its OWN number series
   * (`CN-{FY}/{000001}`), because it is a distinct statutory document and mixing
   * it into the gapless invoice run is indefensible in an audit.
   *
   * Amounts are stored POSITIVE, exactly as they are on the paper document. The
   * return accumulator subtracts them; storing negatives would double-negate the
   * moment anything else summed the column.
   */
  async createCreditNote(orgId: string, invoiceId: string, dto: CreateCreditNoteDto) {
    return retryOnNumberingConflict(
      () =>
        this.prisma.$transaction(
          (tx) => this.createCreditNoteTx(tx, orgId, invoiceId, dto),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10000,
          },
        ),
      {
        isRetriableUniqueViolation: (e) =>
          uniqueViolationTargets(e, 'invoiceNumber'),
        onRetry: (attempt) =>
          this.logger.warn(
            `Credit note number collision on attempt ${attempt} — retrying`,
          ),
      },
    );
  }

  private async createCreditNoteTx(
    tx: Prisma.TransactionClient,
    orgId: string,
    invoiceId: string,
    dto: CreateCreditNoteDto,
  ) {
    const original = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId: orgId },
      include: { lineItems: true },
    });
    if (!original) throw new NotFoundException('Invoice not found');

    if (original.status !== InvoiceStatus.ISSUED) {
      throw new BadRequestException(
        `Only an issued invoice can be credited. This one is ${original.status}.`,
      );
    }

    const org = await tx.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true, gstEnabled: true },
    });
    const timeZone = this.gstTimeZone(orgId, org);

    // The credit note itself is dated TODAY and lands in today's period, so the
    // period being locked is the one it is issued into — not the one the
    // original invoice sits in. Crediting a filed month is exactly the
    // supported correction, which is why the ORIGINAL's period is not checked.
    const noteDate = new Date();
    await this.assertPeriodOpen(
      tx,
      orgId,
      noteDate,
      original.sellerGstinId,
      timeZone,
      'Raising a credit note',
    );

    const alreadyCredited = await tx.invoice.aggregate({
      where: {
        organizationId: orgId,
        creditNoteForId: invoiceId,
        status: InvoiceStatus.CREDIT_NOTE,
      },
      _sum: { grandTotal: true },
    });

    const originalTotal = new Prisma.Decimal(original.grandTotal);
    const credited = new Prisma.Decimal(alreadyCredited._sum.grandTotal ?? 0);
    const remaining = originalTotal.minus(credited);

    if (remaining.lessThanOrEqualTo(0)) {
      throw new ConflictException(
        `Invoice ${original.invoiceNumber} is already fully credited.`,
      );
    }

    // Full reversal unless an amount is given. A partial credit is apportioned
    // pro-rata across the original lines by taxable value, so every line keeps
    // its own rate and the reversed tax stays proportional — the alternative,
    // guessing which lines were returned, is not knowable from an amount.
    const requested = dto.amount ? new Prisma.Decimal(dto.amount) : remaining;
    if (requested.greaterThan(remaining)) {
      throw new BadRequestException(
        `Cannot credit ${requested.toFixed(2)}: only ${remaining.toFixed(2)} of ` +
          `invoice ${original.invoiceNumber} remains uncredited.`,
      );
    }

    const isFull = requested.equals(remaining) && credited.isZero();
    const ratio = originalTotal.isZero()
      ? new Prisma.Decimal(0)
      : requested.dividedBy(originalTotal);

    const scale = (value: Prisma.Decimal.Value) =>
      isFull
        ? new Prisma.Decimal(value)
        : new Prisma.Decimal(value).times(ratio).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    const financialYear = this.calculator.getFinancialYear(noteDate, timeZone);
    const noteNumber = await this.invoiceNumber.getNextCreditNoteNumber(
      orgId,
      financialYear,
      tx,
    );

    const lines = original.lineItems.map((li) => ({
      orderLineItemId: li.orderLineItemId,
      description: li.description,
      hsnCode: li.hsnCode,
      unitOfMeasure: li.unitOfMeasure,
      supplyType: li.supplyType,
      quantity: isFull ? li.quantity : 0,
      unitPrice: li.unitPrice,
      discount: scale(li.discount),
      taxableValue: scale(li.taxableValue),
      gstRate: li.gstRate,
      cgstRate: li.cgstRate,
      cgstAmount: scale(li.cgstAmount),
      sgstRate: li.sgstRate,
      sgstAmount: scale(li.sgstAmount),
      igstRate: li.igstRate,
      igstAmount: scale(li.igstAmount),
      totalTax: scale(li.totalTax),
      totalAmount: scale(li.totalAmount),
    }));

    const note = await tx.invoice.create({
      data: {
        organizationId: orgId,
        orderId: original.orderId,
        sellerGstinId: original.sellerGstinId,
        invoiceNumber: noteNumber,
        invoiceDate: noteDate,
        financialYear,
        status: InvoiceStatus.CREDIT_NOTE,
        creditNoteForId: original.id,
        creditNoteReason: dto.reason,
        // Seller and buyer are copied from the original: a credit note names the
        // same two parties, and re-deriving them could disagree with the
        // document it reverses.
        sellerGstin: original.sellerGstin,
        sellerLegalName: original.sellerLegalName,
        sellerAddress: original.sellerAddress ?? undefined,
        sellerStateCode: original.sellerStateCode,
        sellerStateName: original.sellerStateName,
        // Dispatch block copied too: a credit note reverses a specific supply,
        // and must describe the same movement of goods the invoice did.
        dispatchWarehouseId: original.dispatchWarehouseId,
        dispatchName: original.dispatchName,
        dispatchAddress:
          (original.dispatchAddress as Prisma.InputJsonValue | null) ?? undefined,
        dispatchStateCode: original.dispatchStateCode,
        buyerName: original.buyerName,
        buyerGstin: original.buyerGstin,
        buyerAddress: original.buyerAddress ?? undefined,
        buyerStateCode: original.buyerStateCode,
        buyerStateName: original.buyerStateName,
        placeOfSupply: original.placeOfSupply,
        placeOfSupplyName: original.placeOfSupplyName,
        gstType: original.gstType,
        subtotal: scale(original.subtotal),
        totalCgst: scale(original.totalCgst),
        totalSgst: scale(original.totalSgst),
        totalIgst: scale(original.totalIgst),
        totalTax: scale(original.totalTax),
        totalDiscount: scale(original.totalDiscount),
        shippingCharge: scale(original.shippingCharge),
        grandTotal: requested,
        currency: original.currency,
        reverseCharge: original.reverseCharge,
        notes: dto.notes,
        lineItems: { create: lines },
      },
      include: { lineItems: true },
    });

    this.logger.log(
      `Credit note ${noteNumber} raised against ${original.invoiceNumber} ` +
        `for ${requested.toFixed(2)} ${original.currency}` +
        (isFull ? ' (full reversal)' : ' (partial, apportioned pro-rata)'),
    );

    return note;
  }

  // ─── GST RETURN SUMMARY ───
  async getGstReturn(orgId: string, query: QueryGstReturnDto) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true, gstEnabled: true },
    });

    // Period boundaries are anchored to the merchant's timezone. On a UTC
    // server, naive local-time math shifted every month/quarter edge by the
    // offset — for IST that meant sales in the first 5.5 hours of a month were
    // missing from its return, and sales in the first 5.5 hours of the NEXT
    // month were reported inside it.
    const dateRange = this.getDateRangeForPeriod(
      query.financialYear,
      query.period,
      this.gstTimeZone(orgId, org),
    );

    // Built ONCE and reused by both the count and every page. If the two ever
    // used different predicates, the cap check would be policing a different
    // set than the one actually assembled — the original truncation bug in a
    // subtler form.
    //
    // NOTE: `financialYear` is deliberately NOT filtered here, unlike the list
    // and stats queries where it is the user's own filter. It is stamped onto
    // the invoice at issue time from the org's THEN-current timezone, while the
    // window below is computed from the CURRENT one. A timezone change (or the
    // IST fallback engaging) desynchronises them for invoices near 1 April, and
    // AND-ing both silently drops those rows from a statutory return. The
    // statute defines the period as dates, so the date window is authoritative.
    const where: Prisma.InvoiceWhereInput = {
      organizationId: orgId,
      // Credit notes ride along with invoices: they are reported in GSTR-1
      // table 9B and NETTED out of GSTR-3B 3.1(a), so the fold needs both in
      // one pass. Excluding them is what left refunded sales in declared
      // liability for ever.
      status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.CREDIT_NOTE] },
      invoiceDate: {
        gte: dateRange.from,
        // Half-open. The previous inclusive `23:59:59` bound carried no
        // milliseconds, so an invoice at 23:59:59.500 was silently dropped.
        lt: dateRange.toExclusive,
      },
      ...(query.sellerGstinId && { sellerGstinId: query.sellerGstinId }),
      // Reference view only — see QueryGstReturnDto.dispatchWarehouseId. The
      // accumulators are untouched; the fold simply sees fewer invoices.
      ...(query.dispatchWarehouseId && {
        dispatchWarehouseId: query.dispatchWarehouseId,
      }),
    };

    const isGstr3b = query.returnType === GstReturnType.GSTR3B;
    // The B2CL threshold decides whether an inter-state B2C invoice is
    // reported invoice-wise (Table 5) or summarised (Table 7), so it has to
    // reach the accumulator.
    const settingsRow = await this.prisma.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { taxSettings: true },
    });
    const taxSettings = parseTaxSettings(settingsRow?.taxSettings ?? null);

    const accumulator = isGstr3b
      ? new Gstr3bAccumulator()
      : new Gstr1Accumulator({
          b2cLargeThreshold: taxSettings.b2cLargeThreshold,
        });

    await this.foldReturnInvoices(where, (invoice) =>
      accumulator.addInvoice(invoice),
    );

    const result = accumulator.finish();

    // GSTR-1 Table 13 — documents issued. Read separately from the fold and
    // AFTER it, for two reasons: it must include CANCELLED invoices (which the
    // return's own `where` excludes by design, since a cancelled document
    // reports no supply but still consumes a serial), and it needs only three
    // scalar columns rather than the full invoice with its line items.
    if (!isGstr3b) {
      const documents = await this.prisma.invoice.findMany({
        where: {
          ...where,
          status: {
            in: [
              InvoiceStatus.ISSUED,
              InvoiceStatus.CANCELLED,
              InvoiceStatus.CREDIT_NOTE,
            ],
          },
        },
        select: { invoiceNumber: true, status: true, creditNoteForId: true },
        orderBy: { id: 'asc' },
        take: GST_RETURN_INVOICE_CAP + 1,
      });
      if (documents.length > GST_RETURN_INVOICE_CAP) {
        throw new PayloadTooLargeException(
          `This period holds more than ${GST_RETURN_INVOICE_CAP} documents. Narrow the period or filter by GSTIN.`,
        );
      }
      (result as Gstr1Return).documentsIssued =
        summarizeDocumentSeries(documents);
    }

    // GSTR-3B 3.1(d) and 4(A)(3) — inward supplies on which the RECIPIENT pays
    // the tax. Read here rather than folded into the accumulator because that
    // class folds invoices, which are outward; these are purchases.
    //
    // Cash-neutral but doubly declarable: the liability sits in 3.1(d), the
    // matching credit in 4(A)(3). Omitting both is a non-declaration the
    // department can see, since it knows the merchant paid a foreign supplier.
    if (isGstr3b) {
      (result as Gstr3bReturn).reverseCharge = await this.reverseChargeTotals(
        orgId,
        query.financialYear,
        query.period,
      );
    }

    return result;
  }

  /**
   * Fold the period's reverse-charge inward supplies.
   *
   * ⚠️ An unstated tax is NOT summed as zero. It is counted separately so the
   * caller can present the figure as a floor — the same contract the refund and
   * channel-tax paths hold, and the reason `gstAmount` is nullable at all.
   *
   * IGST throughout: this is scoped to imports of services, where the
   * recipient's location is the place of supply and the supplier sits outside
   * India, making it inter-state by definition. Domestic reverse charge (goods
   * transport, advocates) can be CGST+SGST and is deliberately out of scope.
   */
  private async reverseChargeTotals(
    orgId: string,
    financialYear: string,
    period: string,
  ): Promise<Gstr3bReturn['reverseCharge']> {
    const rows = await this.prisma.inwardSupply.findMany({
      where: {
        organizationId: orgId,
        financialYear,
        period,
        isReverseCharge: true,
      },
      select: { feeAmount: true, gstAmount: true },
    });

    let taxableValue = new Prisma.Decimal(0);
    let igst = new Prisma.Decimal(0);
    let entriesWithUnknownTax = 0;

    for (const row of rows) {
      taxableValue = taxableValue.plus(row.feeAmount);
      if (row.gstAmount === null) {
        entriesWithUnknownTax += 1;
        continue;
      }
      igst = igst.plus(row.gstAmount);
    }

    return {
      taxableValue: parseFloat(taxableValue.toFixed(2)),
      igst: parseFloat(igst.toFixed(2)),
      entriesWithUnknownTax,
    };
  }

  /**
   * Streams every invoice matching `where` through `fold`, in bounded pages.
   *
   * Replaces a single `findMany({ take: 10_000 })` that had NO `orderBy`: past
   * that many invoices a period returned a nondeterministic subset and reported
   * it as the complete return, with nothing telling the caller rows had been
   * dropped. Under-reporting a statutory filing in silence is worse than
   * failing, so the cap now throws and names the real number.
   *
   * Ordering is by `id` because it is the primary key and the only field here
   * guaranteed unique — `invoiceDate` is not, and cursoring on a non-unique
   * column skips and duplicates rows at page boundaries.
   *
   * Each page is folded and then dropped. Collecting pages into one array first
   * would keep exactly the memory footprint this exists to bound, since the
   * expensive part is `include: { lineItems: true }`.
   */
  private async foldReturnInvoices(
    where: Prisma.InvoiceWhereInput,
    fold: (invoice: ReturnInvoice) => void,
  ): Promise<number> {
    const total = await this.prisma.invoice.count({ where });

    if (total > GST_RETURN_INVOICE_CAP) {
      throw new PayloadTooLargeException(
        `This period contains ${total.toLocaleString('en-IN')} invoices, above the ` +
          `${GST_RETURN_INVOICE_CAP.toLocaleString('en-IN')} this return builder can assemble ` +
          `at once. Generate the return for a single GSTIN, or choose one month ` +
          `instead of a quarter.`,
      );
    }

    let cursor: string | undefined;

    for (;;) {
      const page = await this.prisma.invoice.findMany({
        where,
        include: {
          lineItems: true,
          // Table 9B reports the number of the invoice being reversed.
          creditNoteFor: { select: { invoiceNumber: true } },
        },
        orderBy: { id: 'asc' },
        take: GST_RETURN_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      for (const invoice of page) {
        fold({
          ...invoice,
          creditNoteForNumber: invoice.creditNoteFor?.invoiceNumber ?? null,
        } as unknown as ReturnInvoice);
      }

      if (page.length < GST_RETURN_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }

    return total;
  }

  /**
   * Aggregates for the invoice KPI row and the filter-chip counts.
   *
   * The chips must count the whole set rather than the current page, so this
   * cannot be derived from `findAll`'s response.
   *
   * Month boundaries go through `gstPeriodRange` in the merchant's timezone for
   * the reason documented on `getGstReturn`: naive local-time month maths on a
   * UTC server shifts every edge by the offset, which for IST silently moved
   * the first 5.5 hours of each month into the wrong one.
   */
  async getStats(orgId: string, query: QueryInvoiceStatsDto) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true, gstEnabled: true, currency: true },
    });

    const timeZone = this.gstTimeZone(orgId, org);
    const now = new Date();

    const currentMonth = gstPeriodRange(
      getFinancialYear(now, timeZone),
      String(zonedParts(now, timeZone).month).padStart(2, '0'),
      timeZone,
    );

    // One millisecond before this month began is always inside the previous
    // month, so this needs no special case for January.
    const lastInstantOfPrevMonth = new Date(currentMonth.from.getTime() - 1);
    const previousMonth = gstPeriodRange(
      getFinancialYear(lastInstantOfPrevMonth, timeZone),
      String(zonedParts(lastInstantOfPrevMonth, timeZone).month).padStart(2, '0'),
      timeZone,
    );

    // Counts are scoped to the financial year the list is showing; the
    // month-to-date money figures are not, since they are always "this month".
    const scope: Prisma.InvoiceWhereInput = {
      organizationId: orgId,
      ...(query.financialYear && { financialYear: query.financialYear }),
      ...(query.sellerGstinId && { sellerGstinId: query.sellerGstinId }),
    };

    const issuedInMonth = (range: { from: Date; toExclusive: Date }) => ({
      organizationId: orgId,
      ...(query.sellerGstinId && { sellerGstinId: query.sellerGstinId }),
      status: InvoiceStatus.ISSUED,
      invoiceDate: { gte: range.from, lt: range.toExclusive },
    });

    const outstandingWhere: Prisma.InvoiceWhereInput = {
      ...scope,
      status: InvoiceStatus.ISSUED,
      order: { financialStatus: { in: OUTSTANDING_FINANCIAL_STATES } },
    };

    const [
      thisMonth,
      lastMonth,
      outstanding,
      all,
      issued,
      cancelled,
      b2b,
      unpaid,
      uninvoicedPaidOrders,
      taxMismatches,
      invoicesMissingHsn,
      invoicesFromUnlinkedWarehouse,
      refundsNeedingCreditNoteRows,
    ] = await Promise.all([
      this.sumConverted(issuedInMonth(currentMonth)),
      this.sumConverted(issuedInMonth(previousMonth)),
      this.sumConverted(outstandingWhere),
      this.prisma.invoice.count({ where: scope }),
      this.prisma.invoice.count({
        where: { ...scope, status: InvoiceStatus.ISSUED },
      }),
      this.prisma.invoice.count({
        where: { ...scope, status: InvoiceStatus.CANCELLED },
      }),
      this.prisma.invoice.count({
        where: { ...scope, buyerGstin: { not: null } },
      }),
      this.prisma.invoice.count({ where: outstandingWhere }),
      // Paid orders carrying no live invoice. Deliberately NOT scoped to
      // `query.financialYear`: an org accruing uninvoiced paid orders needs to
      // know regardless of which year the tab is showing.
      //
      // Counted by ABSENCE OF AN INVOICE rather than by `invoiceError`, which
      // was wrong in both directions. It missed every order auto-invoicing
      // skipped silently — the setting off, or the order ingested by a sync
      // rather than a webhook — which is the case a merchant most needs to
      // see. And it counted orders whose only "error" was a duplicate attempt
      // that had been correctly rejected, so a perfectly invoiced order drove
      // the warning banner.
      this.prisma.order.count({
        where: {
          organizationId: orgId,
          deletedAt: null,
          financialStatus: OrderFinancialStatus.PAID,
          invoices: {
            none: {
              status: { notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.CREDIT_NOTE] },
            },
          },
        },
      }),
      // Invoices whose declared tax diverged from what the channel charged.
      // Backed by the partial index invoices_org_tax_mismatch_idx.
      //
      // ISSUED only, matching the HSN warning below. A CANCELLED invoice is not
      // filable and cannot need reconciling before filing, but it was still
      // counted — so cancelling a wrongly-taxed invoice and reissuing it
      // correctly RAISED the warning count instead of clearing it, which is the
      // exact remedy the warning is asking the merchant to perform.
      this.prisma.invoice.count({
        where: { ...scope, status: InvoiceStatus.ISSUED, taxMismatch: true },
      }),
      // Issued invoices carrying a line with no HSN. Table 12 cannot be filed
      // until this is zero. Backed by invoices_org_hsn_missing_idx.
      this.prisma.invoice.count({
        where: { ...scope, status: InvoiceStatus.ISSUED, hsnMissing: true },
      }),
      // Invoices dispatched from a warehouse that belongs to no GST
      // registration. Every place of business invoicing under a GSTIN has to be
      // declared under that registration on the portal, so an unlinked one is a
      // compliance gap the merchant should close before filing.
      //
      // A WARNING, not a block: an org that has warehouses but has not linked
      // them yet would otherwise be unable to invoice at all from the day this
      // shipped. Orgs that do not use warehousing never see it.
      this.prisma.invoice.count({
        where: {
          ...scope,
          status: InvoiceStatus.ISSUED,
          dispatchWarehouseId: { not: null },
          dispatchWarehouse: { gstinId: null },
        },
      }),
      // Refunded orders whose invoice has NOT been credited.
      //
      // This is what makes credit notes actually work. The machinery shipped
      // but nothing surfaced the need, so a refunded sale sat at full value in
      // the return until somebody remembered to open that invoice — which is
      // the exact problem credit notes were built to solve.
      //
      // Deliberately NOT financial-year scoped, like uninvoicedPaidOrders: an
      // org carrying uncredited refunds needs to know regardless of which year
      // the tab is showing.
      // Raw SQL because this is an AGGREGATE comparison — refunded total
      // against credited total — which a Prisma `count` cannot express.
      //
      // The predicate it replaces was "has no credit note at all", so an order
      // part-credited once dropped out of the warning permanently even when it
      // was refunded again afterwards with money still uncredited. It also has
      // to agree exactly with `listRefundsNeedingCreditNote`, or this banner
      // states a number the list beneath it contradicts.
      //
      // Credit notes store POSITIVE amounts, as on the paper document, so this
      // is a straight greater-than.
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count
        FROM orders o
        WHERE o.organization_id = ${orgId}
          AND o.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = o.id)
          AND EXISTS (
            SELECT 1 FROM invoices i
            WHERE i.order_id = o.id AND i.status = 'ISSUED'
          )
          AND COALESCE(
                (SELECT SUM(r.amount) FROM order_refunds r WHERE r.order_id = o.id), 0
              ) > COALESCE(
                (SELECT SUM(i.grand_total) FROM invoices i
                 WHERE i.order_id = o.id AND i.status = 'CREDIT_NOTE'), 0
              )
      `,
    ]);

    const decimal = (value: Prisma.Decimal | null | undefined) =>
      value ? Math.round(parseFloat(value.toString()) * 100) / 100 : 0;

    // `sumConverted` already multiplies by an FX rate, so it returns plain
    // numbers rather than Decimals — round them the same way.
    const round2 = (value: number) => Math.round(value * 100) / 100;

    const invoicedNow = round2(thisMonth.grandTotal);
    const invoicedPrev = round2(lastMonth.grandTotal);
    const taxNow = round2(thisMonth.totalTax);
    const taxPrev = round2(lastMonth.totalTax);

    return {
      invoicedThisMonth: {
        amount: invoicedNow,
        changePct: this.percentChange(invoicedNow, invoicedPrev),
      },
      taxCollected: {
        amount: taxNow,
        changePct: this.percentChange(taxNow, taxPrev),
      },
      outstanding: {
        amount: round2(outstanding.grandTotal),
        invoiceCount: unpaid,
        // Outstanding is a running balance, not a monthly flow. Reporting a
        // month-over-month delta would need a historical snapshot of what was
        // owed at the end of last month, which nothing records — so this is
        // null and the card omits its trend badge rather than inventing one.
        changePct: null,
      },
      periodStart: currentMonth.from.toISOString(),
      periodEnd: now.toISOString(),
      // No `draft`: InvoiceStatus.DRAFT is in the enum but no code path ever
      // writes it, so the count was structurally always 0 — it drove a filter
      // chip that could never match and a KPI sub-label that always read
      // "· 0 drafts". Reinstate it alongside a real draft-invoice lifecycle.
      counts: { all, issued, unpaid, b2b, cancelled },
      // Siblings of `counts`, not members of it: `counts` counts INVOICES and
      // drives the filter chips, while these two are warnings — one counts
      // ORDERS, and neither corresponds to a chip.
      uninvoicedPaidOrders,
      taxMismatches,
      invoicesMissingHsn,
      invoicesFromUnlinkedWarehouse,
      refundsNeedingCreditNote: Number(
        refundsNeedingCreditNoteRows[0]?.count ?? 0,
      ),
      currency: org?.currency ?? 'INR',
    };
  }

  /**
   * Sum invoice money in the ORGANISATION's currency.
   *
   * An invoice is denominated in its order's currency, so `_sum(grandTotal)`
   * added currencies together — "₹7,408 invoiced this month" was ₹1,911.50 of
   * rupee invoices plus $5,496.07 of dollar ones counted as rupees.
   *
   * Prisma's `aggregate` can only sum a column, never a product, so the rows
   * are summed here instead of in SQL. Deliberately NOT rewritten as raw SQL:
   * the `where` clauses are shared with the counts beside them, and restating
   * those filters in SQL would give the same tile two definitions that could
   * drift apart. Volumes are per-organisation and per-month, so this stays a
   * small read.
   *
   * The rate lives on the ORDER, not the invoice: the invoice is raised from
   * the order and inherits its currency, so re-deriving a rate here could
   * disagree with the figure the order was already booked at.
   */
  private async sumConverted(
    where: Prisma.InvoiceWhereInput,
  ): Promise<{ grandTotal: number; totalTax: number; unconverted: number }> {
    const rows = await this.prisma.invoice.findMany({
      where,
      select: {
        grandTotal: true,
        totalTax: true,
        order: { select: { exchangeRate: true } },
      },
    });

    let grandTotal = 0;
    let totalTax = 0;
    let unconverted = 0;

    for (const row of rows) {
      const rate = row.order?.exchangeRate;
      // No resolved rate means no honest way to add this invoice to a total in
      // another currency. Counted, not coerced to 1.
      if (rate == null) {
        unconverted += 1;
        continue;
      }
      const factor = Number(rate);
      grandTotal += Number(row.grandTotal) * factor;
      totalTax += Number(row.totalTax) * factor;
    }

    return { grandTotal, totalTax, unconverted };
  }

  /**
   * Percentage change, rounded. Null when there is no prior basis: a jump from
   * zero is not "100% up", and passing 0 would render a green up-trend badge.
   */
  private percentChange(current: number, previous: number): number | null {
    if (!previous) return null;
    return Math.round(((current - previous) / previous) * 100);
  }

  // ─── EXPORT INVOICES AS CSV ───
  /**
   * Rows for the CSV / JSON export.
   *
   * Shares `buildInvoiceWhere` and `buildInvoiceOrderBy` with `findAll` on
   * purpose: this used to hand-roll a filter honouring only financialYear /
   * status / sellerGstinId, so the Export CSV button sitting beside a searched,
   * date-filtered, B2B-chipped table produced a file containing rows the user
   * could not see and omitting none of the ones they could. The export now
   * means exactly "what is on screen", bounded by EXPORT_ROW_CAP.
   */
  async getExportData(orgId: string, query: QueryInvoicesDto) {
    const where = this.buildInvoiceWhere(
      orgId,
      query,
      await this.listTimeZone(orgId, query),
    );

    const invoices = await this.prisma.invoice.findMany({
      where,
      // Bounded: this used to be unlimited, so one request on a large tenant
      // could hydrate the whole table into memory and OOM the process for
      // every tenant. See EXPORT_ROW_CAP.
      take: EXPORT_ROW_CAP,
      orderBy: this.buildInvoiceOrderBy(query),
      include: {
        order: { select: { name: true } },
      },
    });

    return invoices.map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate.toISOString().split('T')[0],
      financialYear: inv.financialYear,
      orderNumber: inv.order.name,
      buyerName: inv.buyerName,
      buyerGstin: inv.buyerGstin || 'B2C',
      placeOfSupply: formatPlaceOfSupply(
        inv.placeOfSupply,
        inv.placeOfSupplyName,
      ),
      gstType: inv.gstType,
      subtotal: inv.subtotal.toString(),
      discount: inv.totalDiscount.toString(),
      cgst: inv.totalCgst.toString(),
      sgst: inv.totalSgst.toString(),
      igst: inv.totalIgst.toString(),
      totalTax: inv.totalTax.toString(),
      // Included so a reader can reconcile the row: subtotal + totalTax +
      // shipping = grandTotal. Without it the last two columns look wrong.
      shipping: inv.shippingCharge.toString(),
      grandTotal: inv.grandTotal.toString(),
      status: inv.status,
      // Appended AFTER status so existing column positions do not shift for
      // anyone with a saved import mapping.
      dispatchFrom: inv.dispatchName ?? '',
    }));
  }

  // ─── GST RETURN CSV EXPORT ───
  /**
   * CSV rows for a GST return.
   *
   * Row shaping lives in `gst-return-rows.ts` so it can be tested against a
   * literal return object, with no Prisma. This method is now only fetch +
   * delegate — and it inherits the return builder’s no-truncation guarantee
   * for free, which matters because the CSV is the artefact actually filed.
   */
  async getGstReturnExportData(
    orgId: string,
    query: QueryGstReturnDto,
    actor?: { email?: string },
  ): Promise<CsvSection[]> {
    const returnData = await this.getGstReturn(orgId, query);

    const sections =
      query.returnType === GstReturnType.GSTR3B
        ? buildGstr3bSections(returnData as Gstr3bReturn)
        : buildGstr1Sections(returnData as Gstr1Return);

    // Provenance block, first. A filing pack has to say which registration and
    // period it covers, when it was produced and by whom — otherwise two
    // exports of the same period, taken before and after a correction, are
    // indistinguishable once they are sitting in the accountant's folder.
    const [gstin, warehouse] = await Promise.all([
      query.sellerGstinId
        ? this.prisma.organizationGstin.findFirst({
            where: { id: query.sellerGstinId, organizationId: orgId },
            select: { gstin: true, stateName: true },
          })
        : null,
      query.dispatchWarehouseId
        ? this.prisma.warehouse.findFirst({
            where: { id: query.dispatchWarehouseId, organizationId: orgId },
            select: { name: true, code: true },
          })
        : null,
    ]);

    const metadata: CsvSection = {
      title: 'Return metadata',
      headers: ['Field', 'Value'],
      rows: [
        ['Return', query.returnType ?? GstReturnType.GSTR1],
        [
          'GSTIN',
          gstin ? `${gstin.gstin} (${gstin.stateName})` : 'All registrations',
        ],
        ['Financial year', query.financialYear],
        ['Period', query.period],
        ['Generated at', new Date().toISOString()],
        ['Generated by', actor?.email ?? 'Unknown'],
      ],
    };

    // Only when scoped — a line saying "All warehouses" on every other export
    // would imply the return HAS a warehouse dimension, which it does not.
    if (warehouse) {
      metadata.rows.push([
        'Warehouse scope',
        `${warehouse.name} (${warehouse.code}) — REFERENCE ONLY, not a filing`,
      ]);
    }

    return [metadata, ...sections];
  }

  /**
   * Timezone for this org's GST date math, warning once if it had to fall back
   * to IST because GST is on but the timezone is still the untouched default.
   */
  private gstTimeZone(
    orgId: string,
    org: { timezone?: string | null; gstEnabled?: boolean | null } | null,
  ): string {
    const timeZone = resolveGstTimeZone(org ?? {});

    if (
      timeZone === INDIA_TZ &&
      (!org?.timezone || org.timezone === 'UTC') &&
      !gstTimeZoneFallbackWarned.has(orgId)
    ) {
      gstTimeZoneFallbackWarned.add(orgId);
      this.logger.warn(
        `Org ${orgId} has GST enabled but no timezone set (still "UTC"); ` +
          `using ${INDIA_TZ} for financial-year and GST period boundaries. ` +
          `Set the organization timezone in Settings to make this explicit.`,
      );
    }

    return timeZone;
  }

  // ─── HELPER: Resolve the dispatch warehouse ───
  /**
   * Which additional place of business the goods left from, for the invoice's
   * "Dispatch From" snapshot. Returns null when the org does not track
   * warehouses, or when no defensible answer exists.
   *
   * Three tiers, and the STRICTNESS DIFFERS BY TIER on purpose:
   *
   *   1. An explicitly chosen warehouse, and
   *   2. the warehouse the order was actually stamped with
   *      — are ASSERTIONS. If either is registered under a different GSTIN
   *      than the one issuing this invoice, that is a statutory error on a
   *      document, so it throws rather than quietly dropping the block.
   *
   *   3. The org's default warehouse is only a GUESS. A multi-registration org
   *      selling into a state where it is separately registered resolves a
   *      seller GSTIN that its default warehouse may have nothing to do with;
   *      refusing the invoice over the app's own fallback would block ordinary
   *      sales. A guess that contradicts the seller is discarded, not fatal.
   *
   * The order-stamped tier deliberately does NOT require `isActive`: it records
   * where the goods actually went out from, and a warehouse retired afterwards
   * does not retroactively change that.
   */
  private async resolveDispatchWarehouse(
    tx: Prisma.TransactionClient,
    orgId: string,
    explicitId: string | undefined,
    orderStampedId: string | null,
    sellerGstinId: string,
  ): Promise<{
    id: string;
    name: string;
    address: unknown;
    stateCode: string | null;
  } | null> {
    const select = {
      id: true,
      name: true,
      address: true,
      gstinId: true,
      gstin: { select: { stateCode: true } },
    } as const;

    const shape = (w: {
      id: string;
      name: string;
      address: unknown;
      gstin: { stateCode: string } | null;
    }) => ({
      id: w.id,
      name: w.name,
      address: w.address,
      // The address is the primary source; the linked registration's state is
      // the fallback for a warehouse whose address was never filled in.
      stateCode: extractStateFromAddress(w.address) ?? w.gstin?.stateCode ?? null,
    });

    const assertSameRegistration = (w: { name: string; gstinId: string | null }) => {
      if (w.gstinId && w.gstinId !== sellerGstinId) {
        throw new BadRequestException(
          `Dispatch warehouse "${w.name}" is registered under a different GSTIN ` +
            'than the seller GSTIN on this invoice. Pick another dispatch ' +
            'warehouse, or change the seller GSTIN.',
        );
      }
    };

    if (explicitId) {
      const warehouse = await tx.warehouse.findFirst({
        where: { id: explicitId, organizationId: orgId, isActive: true },
        select,
      });
      if (!warehouse) throw new NotFoundException('Warehouse not found');
      assertSameRegistration(warehouse);
      return shape(warehouse);
    }

    if (orderStampedId) {
      const warehouse = await tx.warehouse.findFirst({
        where: { id: orderStampedId, organizationId: orgId },
        select,
      });
      if (warehouse) {
        assertSameRegistration(warehouse);
        return shape(warehouse);
      }
    }

    const fallback = await tx.warehouse.findFirst({
      where: { organizationId: orgId, isDefault: true, isActive: true },
      select,
    });
    if (!fallback) return null;
    if (fallback.gstinId && fallback.gstinId !== sellerGstinId) return null;
    return shape(fallback);
  }

  // ─── HELPER: Resolve place of supply ───
  /**
   * Trust the code the ORDER was actually taxed with when it has one, so the
   * invoice can never report a different tax head or amount than the customer
   * was charged. Only orders created before `Order.placeOfSupplyCode` existed
   * (or an explicit caller override) fall through to the shared resolver.
   */
  private resolvePlaceOfSupply(
    dto: { placeOfSupplyCode?: string; buyerGstin?: string },
    order: any,
    sellerStateCode?: string | null,
  ): string {
    if (dto.placeOfSupplyCode && isValidStateCode(dto.placeOfSupplyCode)) {
      return dto.placeOfSupplyCode;
    }

    if (order.placeOfSupplyCode && isValidStateCode(order.placeOfSupplyCode)) {
      return order.placeOfSupplyCode;
    }

    return resolvePlaceOfSupply({
      shippingAddress: order.shippingAddress,
      billingAddress: order.billingAddress,
      customerBillingStateCode: order.customer?.billingStateCode,
      buyerGstin: dto.buyerGstin || order.customer?.gstin,
      // Over-the-counter default. Previously this chain bottomed out at '00',
      // which matches no StateTaxRate row, so a walk-in invoice could compute
      // 0% tax on a sale the order had charged the full rate for.
      sellerStateCode,
    });
  }

  private extractStateFromAddress(address: unknown): string | null {
    return extractStateFromAddress(address);
  }

  /**
   * Half-open [from, toExclusive) instants for a GST return period, anchored to
   * the merchant's timezone rather than the server's (which is UTC on every
   * deployment target). Delegates to the shared helper so the financial-year
   * stamp and the period window can't drift apart.
   */
  private getDateRangeForPeriod(
    financialYear: string,
    period: string,
    timeZone: string,
  ): { from: Date; toExclusive: Date } {
    try {
      return gstPeriodRange(financialYear, period, timeZone);
    } catch (error) {
      // `gstPeriodRange` throws a bare Error, which NestJS renders as a 500.
      // The DTOs now reject malformed values up front, so reaching this means
      // a caller bypassed them — still the caller's mistake, so still a 400.
      // Kept here rather than in zoned-date.util.ts so that helper stays free
      // of Nest imports and usable from scripts.
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid GST return period.',
      );
    }
  }
}
