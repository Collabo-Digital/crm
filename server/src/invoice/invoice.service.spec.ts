import {
  PayloadTooLargeException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { Test, TestingModule } from '@nestjs/testing';
import { GstType, InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GstService } from '../gst/gst.service';
import { GstCalculatorService } from '../gst/gst-calculator.service';
import { TaxResolverService } from '../gst/tax-resolver.service';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoiceService } from './invoice.service';
import { CommerceEventsService } from '../commerce/commerce-events.service';
import { GstReturnType } from './dto/query-gst-return.dto';

/**
 * `getGstReturn` assembles a STATUTORY FILING.
 *
 * The defect this covers: it used to be a single `findMany({ take: 10_000 })`
 * with no `orderBy`. A period with more invoices than that returned a
 * nondeterministic subset and reported it as the complete return — the merchant
 * filed under-declared figures and nothing anywhere said so. Silently
 * under-reporting is the worst available failure mode for this endpoint, which
 * is why the cap now throws instead of truncating.
 */
describe('InvoiceService.getGstReturn', () => {
  let service: InvoiceService;
  let prisma: {
    organization: { findUnique: jest.Mock };
    organizationSettings: { findUnique: jest.Mock };
    inwardSupply: { findMany: jest.Mock };
    invoice: { count: jest.Mock; findMany: jest.Mock };
  };

  /** A minimal issued invoice, as `include: { lineItems: true }` returns it. */
  const invoiceAt = (n: number) => ({
    status: InvoiceStatus.ISSUED,
    id: `inv_${String(n).padStart(6, '0')}`,
    invoiceNumber: `INV-2026-27/${String(n).padStart(6, '0')}`,
    invoiceDate: new Date('2026-08-10T00:00:00.000Z'),
    buyerGstin: null,
    buyerName: 'Guest Customer',
    placeOfSupply: '29',
    placeOfSupplyName: 'Karnataka',
    gstType: GstType.IGST,
    subtotal: '100.00',
    totalCgst: '0.00',
    totalSgst: '0.00',
    totalIgst: '18.00',
    totalTax: '18.00',
    grandTotal: '118.00',
    lineItems: [
      {
        hsnCode: '6109',
        unitOfMeasure: 'NOS',
        supplyType: 'TAXABLE',
        description: 'Cotton Shirt',
        quantity: 1,
        taxableValue: '100.00',
        gstRate: '18.00',
        cgstAmount: '0.00',
        sgstAmount: '0.00',
        igstAmount: '18.00',
        totalTax: '18.00',
      },
    ],
  });

  beforeEach(async () => {
    prisma = {
      organization: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ timezone: 'Asia/Kolkata', gstEnabled: true }),
      },
      // The B2CL threshold reaches the accumulator from here. Null means the
      // org never configured one, so the schema default applies.
      organizationSettings: {
        findUnique: jest.fn().mockResolvedValue({ taxSettings: null }),
      },
      // GSTR-3B 3.1(d) reads reverse-charge purchases from here. Empty by
      // default: a period with no imported services must produce a zeroed row,
      // not a crash.
      inwardSupply: { findMany: jest.fn().mockResolvedValue([]) },
      invoice: { count: jest.fn(), findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceService,
        { provide: PrismaService, useValue: prisma },
        { provide: GstService, useValue: {} },
        { provide: GstCalculatorService, useValue: new GstCalculatorService() },
        { provide: TaxResolverService, useValue: {} },
        { provide: InvoiceNumberService, useValue: {} },
        { provide: CommerceEventsService, useValue: { invoiceIssued: jest.fn() } },
      ],
    }).compile();

    service = module.get(InvoiceService);
  });

  const query = {
    financialYear: '2026-27',
    period: '08',
    returnType: GstReturnType.GSTR1,
  };

  it('refuses to build a return larger than the cap, naming the real count', async () => {
    // Erroring is deliberate. Returning 50,000 of 62,431 invoices would look
    // like a complete return and be filed as one.
    prisma.invoice.count.mockResolvedValue(62_431);

    await expect(service.getGstReturn('org1', query)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    await expect(service.getGstReturn('org1', query)).rejects.toThrow(/62,431/);
    // It must not have started hydrating rows before refusing.
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('pages with a cursor and drops no invoice', async () => {
    // 2,500 invoices across three pages of 1,000. The old single capped query
    // would have returned an arbitrary subset with no ordering at all.
    const all = Array.from({ length: 2_500 }, (_, i) => invoiceAt(i + 1));
    prisma.invoice.count.mockResolvedValue(all.length);
    prisma.invoice.findMany.mockImplementation(({ cursor, take }: any) => {
      const start = cursor ? all.findIndex((i) => i.id === cursor.id) + 1 : 0;
      return Promise.resolve(all.slice(start, start + take));
    });

    const result: any = await service.getGstReturn('org1', query);

    expect(result.totals.totalInvoices).toBe(2_500);
    // 2500 × 100.00 and 2500 × 18.00, exactly.
    expect(result.totals.totalTaxable).toBe(250_000);
    expect(result.totals.totalIgst).toBe(45_000);
    // Three fold pages, plus one lean read for Table 13 (documents issued),
    // which must also count CANCELLED invoices the fold deliberately excludes.
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(4);
  });

  it('orders by a unique column, so pages cannot skip or repeat rows', async () => {
    // `invoiceDate` is not unique — cursoring on it loses rows at page
    // boundaries. `id` is the primary key.
    prisma.invoice.count.mockResolvedValue(1);
    prisma.invoice.findMany.mockResolvedValue([invoiceAt(1)]);

    await service.getGstReturn('org1', query);

    expect(prisma.invoice.findMany.mock.calls[0][0].orderBy).toEqual({ id: 'asc' });
  });

  it('stops after a short page instead of querying forever', async () => {
    prisma.invoice.count.mockResolvedValue(3);
    prisma.invoice.findMany.mockResolvedValue([invoiceAt(1), invoiceAt(2), invoiceAt(3)]);

    await service.getGstReturn('org1', query);

    // One fold page (short, so no second) plus the Table 13 read.
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(2);
  });

  it('filters on the timezone-anchored window, NOT the stored financialYear', async () => {
    // `financialYear` is stamped at issue time from the org's then-current
    // timezone; the window is computed from the current one. AND-ing both
    // silently dropped invoices near 1 April whenever the two disagreed.
    prisma.invoice.count.mockResolvedValue(0);
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.getGstReturn('org1', query);

    const where = prisma.invoice.count.mock.calls[0][0].where;
    expect(where.financialYear).toBeUndefined();
    expect(where.organizationId).toBe('org1');
    // Credit notes ride along: they are reported in table 9B and netted out of
    // 3.1(a), so excluding them is what left refunded sales in liability.
    expect(where.status).toEqual({
      in: [InvoiceStatus.ISSUED, InvoiceStatus.CREDIT_NOTE],
    });
    // August 2026 in IST: 1 Aug 00:00 IST === 31 Jul 18:30 UTC, half-open.
    expect(where.invoiceDate.gte.toISOString()).toBe('2026-07-31T18:30:00.000Z');
    expect(where.invoiceDate.lt.toISOString()).toBe('2026-08-31T18:30:00.000Z');
  });

  it('uses the same predicate for the count and the pages', async () => {
    // A divergence between them would let the cap police a different set than
    // the one actually assembled — the truncation bug in a subtler form.
    prisma.invoice.count.mockResolvedValue(1);
    prisma.invoice.findMany.mockResolvedValue([invoiceAt(1)]);

    await service.getGstReturn('org1', query);

    expect(prisma.invoice.findMany.mock.calls[0][0].where).toBe(
      prisma.invoice.count.mock.calls[0][0].where,
    );
  });

  it('scopes to one registration when a seller GSTIN is given', async () => {
    // A multi-GSTIN org files one return per registration; without this the
    // filing tab could only ever show a merged return.
    prisma.invoice.count.mockResolvedValue(0);
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.getGstReturn('org1', { ...query, sellerGstinId: 'gstin_1' });

    expect(prisma.invoice.count.mock.calls[0][0].where.sellerGstinId).toBe('gstin_1');
  });

  it('rejects an unparseable period as a 400, not a 500', async () => {
    // `gstPeriodRange` throws a bare Error, which NestJS renders as a 500. The
    // DTO rejects these first; this is the guard for any caller that bypasses it.
    await expect(
      service.getGstReturn('org1', { ...query, period: 'nonsense' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('builds GSTR-3B from the same paged read', async () => {
    prisma.invoice.count.mockResolvedValue(2);
    prisma.invoice.findMany.mockResolvedValue([invoiceAt(1), invoiceAt(2)]);

    const result: any = await service.getGstReturn('org1', {
      ...query,
      returnType: GstReturnType.GSTR3B,
    });

    expect(result.taxPayable.igst).toBe(36); // 2 × 18.00
    expect(result.outwardSupplies[0].gstRate).toBe(18);
    // Both invoices are B2C and inter-state, so both belong in table 3.2.
    expect(result.interState.byState[0].invoiceCount).toBe(2);
  });
});

/**
 * Automatic invoicing on the payment edge.
 *
 * Two failures this covers, both seen on real data:
 *   - a redelivered or concurrent webhook re-attempted an invoice, was
 *     correctly rejected with "already exists", and that rejection was stored
 *     on the order as a permanent error — on an order that was perfectly
 *     invoiced — which then drove the uninvoiced-orders banner.
 *   - paying an order inside the CRM wrote PAID locally, so the reconciling
 *     webhook saw PAID → PAID, `becamePaid` returned false, and no invoice was
 *     ever issued.
 */
describe('InvoiceService.autoInvoiceForPaidOrder', () => {
  const ORG = 'org_1';
  const ORDER = 'order_1';

  function build(opts: { enabled?: boolean; liveInvoice?: boolean; createError?: Error } = {}) {
    const orderUpdates: Array<{ where: any; data: any }> = [];
    const prisma = {
      organizationSettings: {
        findUnique: jest.fn().mockResolvedValue({
          orderSettings: { autoInvoiceOnPayment: opts.enabled ?? true },
        }),
      },
      invoice: {
        findFirst: jest.fn().mockResolvedValue(opts.liveInvoice ? { id: 'inv_1' } : null),
      },
      order: {
        updateMany: jest.fn((args: any) => {
          orderUpdates.push(args);
          return Promise.resolve({ count: 1 });
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new InvoiceService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, { invoiceIssued: jest.fn() } as any,
    );
    const create = jest
      .spyOn(service, 'create')
      .mockImplementation(async () =>
        opts.createError
          ? Promise.reject(opts.createError)
          : ({ invoiceNumber: 'INV-26-27/000001' } as any),
      );
    return { service, prisma, create, orderUpdates };
  }

  it('issues an invoice when the org has opted in', async () => {
    const { service, create } = build();
    await service.autoInvoiceForPaidOrder(ORG, ORDER);
    expect(create).toHaveBeenCalledWith(ORG, { orderId: ORDER });
  });

  it('does nothing when the org has not opted in', async () => {
    const { service, create, orderUpdates } = build({ enabled: false });
    await service.autoInvoiceForPaidOrder(ORG, ORDER);
    expect(create).not.toHaveBeenCalled();
    // Not an error either — the merchant chose this.
    expect(orderUpdates).toHaveLength(0);
  });

  it('records the reason when invoicing genuinely fails', async () => {
    const { service, orderUpdates } = build({
      createError: new Error('No GSTIN registration found.'),
    });
    await service.autoInvoiceForPaidOrder(ORG, ORDER);
    expect(orderUpdates).toHaveLength(1);
    expect(orderUpdates[0].data.invoiceError).toMatch(/No GSTIN/);
    expect(orderUpdates[0].data.invoiceErrorAt).toBeInstanceOf(Date);
  });

  it('treats a duplicate attempt on an already-invoiced order as success', async () => {
    const { service, orderUpdates } = build({
      liveInvoice: true,
      createError: new Error('Invoice INV-26-27/000001 already exists for this order.'),
    });

    await service.autoInvoiceForPaidOrder(ORG, ORDER);

    // Clears any stale error rather than recording a new one.
    expect(orderUpdates).toHaveLength(1);
    expect(orderUpdates[0].data).toEqual({ invoiceError: null, invoiceErrorAt: null });
    expect(orderUpdates[0].where.invoiceError).toEqual({ not: null });
  });

  it('never throws, so it cannot break the payment that triggered it', async () => {
    const { service } = build({ createError: new Error('boom') });
    await expect(service.autoInvoiceForPaidOrder(ORG, ORDER)).resolves.toBeUndefined();
  });
});

/**
 * Cash-on-delivery invoicing at dispatch: GST wants the invoice by the time
 * the goods leave, and a COD order is only paid after delivery.
 */
describe('InvoiceService.autoInvoiceForShippedCodOrder', () => {
  const ORG = 'org_1';
  const ORDER = 'order_1';

  function build(
    opts: { enabled?: boolean; gateways?: string[]; cancelled?: boolean; liveInvoice?: boolean; createError?: Error } = {},
  ) {
    const orderUpdates: Array<{ where: any; data: any }> = [];
    const prisma = {
      organizationSettings: {
        findUnique: jest.fn().mockResolvedValue({
          orderSettings: { autoInvoiceCodOnShipping: opts.enabled ?? true },
        }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue({
          cancelledAt: opts.cancelled ? new Date() : null,
          paymentGateways: opts.gateways ?? ['Cash on Delivery (COD)'],
        }),
        updateMany: jest.fn((args: any) => {
          orderUpdates.push(args);
          return Promise.resolve({ count: 1 });
        }),
      },
      invoice: {
        findFirst: jest.fn().mockResolvedValue(opts.liveInvoice ? { id: 'inv_1' } : null),
      },
    };
    const service = new InvoiceService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, { invoiceIssued: jest.fn() } as any,
    );
    const create = jest
      .spyOn(service, 'create')
      .mockImplementation(async () =>
        opts.createError ? Promise.reject(opts.createError) : ({ invoiceNumber: 'INV-26-27/000001' } as any),
      );
    return { service, create, orderUpdates };
  }

  it('invoices a COD order when it ships', async () => {
    const { service, create } = build();
    await service.autoInvoiceForShippedCodOrder(ORG, ORDER);
    expect(create).toHaveBeenCalledWith(ORG, { orderId: ORDER });
  });

  it('does nothing when the org has not opted in', async () => {
    const { service, create } = build({ enabled: false });
    await service.autoInvoiceForShippedCodOrder(ORG, ORDER);
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves prepaid orders to the on-payment path', async () => {
    const { service, create } = build({ gateways: ['razorpay'] });
    await service.autoInvoiceForShippedCodOrder(ORG, ORDER);
    expect(create).not.toHaveBeenCalled();
  });

  it('skips cancelled and already-invoiced orders', async () => {
    for (const opts of [{ cancelled: true }, { liveInvoice: true }]) {
      const { service, create } = build(opts);
      await service.autoInvoiceForShippedCodOrder(ORG, ORDER);
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('records the reason and never throws when invoicing fails', async () => {
    const { service, orderUpdates } = build({ createError: new Error('No GSTIN registration found.') });
    await expect(service.autoInvoiceForShippedCodOrder(ORG, ORDER)).resolves.toBeUndefined();
    expect(orderUpdates[0].data.invoiceError).toMatch(/No GSTIN/);
  });
});

/**
 * Dating at issue time.
 *
 * `invoiceDate` used to be `new Date()`, so a September order invoiced on
 * 8 October was reported in October's return, and a 30 March order invoiced in
 * April drew a serial from the new financial year. The order's placed date is
 * the taxable supply date and decides the GST period.
 */
describe('InvoiceService.createForOrderTx dating', () => {
  const ORG = 'org_1';
  const NOW = new Date('2026-10-08T09:00:00.000Z');

  function build(opts: { placedAt: Date; filings?: Array<object | null> }) {
    const order = {
      id: 'order_1',
      organizationId: ORG,
      externalCreatedAt: opts.placedAt,
      createdAt: opts.placedAt,
      currency: 'INR',
      totalTax: '18.00',
      totalShippingPrice: '0.00',
      billingAddress: null,
      dispatchWarehouseId: null,
      placeOfSupplyCode: '29',
      customer: null,
      lineItems: [
        {
          id: 'li_1',
          title: 'Cotton Shirt',
          variantTitle: null,
          price: '100.00',
          quantity: 1,
          totalDiscount: '0.00',
          taxable: true,
          variant: null,
        },
      ],
    };
    const filings = [...(opts.filings ?? [])];
    const tx = {
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      invoice: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ ...data, lineItems: [] }),
        ),
      },
      organization: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ gstEnabled: true, timezone: 'Asia/Kolkata' }),
      },
      organizationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      organizationGstin: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'gstin_1',
          gstin: '29AABCT1332L1ZN',
          legalName: 'Test Seller',
          address: null,
          stateCode: '29',
          stateName: 'Karnataka',
        }),
      },
      warehouse: { findFirst: jest.fn().mockResolvedValue(null) },
      gstFiling: {
        findFirst: jest.fn(() => Promise.resolve(filings.shift() ?? null)),
      },
    };
    const invoiceNumber = {
      getNextInvoiceNumber: jest.fn().mockResolvedValue('INV-26-27/000001'),
    };
    const taxResolver = { resolveLineGstRates: jest.fn().mockResolvedValue([18]) };
    const service = new InvoiceService(
      {} as any,
      {} as any,
      new GstCalculatorService(),
      taxResolver as any,
      invoiceNumber as any,
      { invoiceIssued: jest.fn() } as any,
    );
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    return { service, tx, invoiceNumber, warn };
  }

  /**
   * The one-live-invoice guard must count the same rows the partial unique
   * index does. A credit note carries the original's orderId; counting it
   * blocked reissuing after the original was cancelled, quoting the credit
   * note's number back as the "existing invoice".
   */
  it("does not treat a credit note as the order's existing invoice", async () => {
    const { service, tx } = build({ placedAt: new Date('2026-10-01T10:00:00.000Z') });
    const rows = [{ invoiceNumber: 'CN-26-27/000001', status: 'CREDIT_NOTE' }];
    tx.invoice.findFirst.mockImplementation((args: any) => {
      const f = args.where.status;
      const hit = rows.find((r) =>
        f?.notIn ? !f.notIn.includes(r.status) : f?.not ? r.status !== f.not : true,
      );
      return Promise.resolve(hit ?? null);
    });

    await expect(service.createForOrderTx(tx as any, ORG, 'order_1', {})).resolves.toBeDefined();
    expect(tx.invoice.create).toHaveBeenCalledTimes(1);
  });

  it('still refuses a second invoice while the original is live', async () => {
    const { service, tx } = build({ placedAt: new Date('2026-10-01T10:00:00.000Z') });
    tx.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-26-27/000001' });

    await expect(service.createForOrderTx(tx as any, ORG, 'order_1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  it('dates the invoice on the day the order was placed, not today', async () => {
    const placedAt = new Date('2026-09-25T10:00:00.000Z');
    const { service, tx, invoiceNumber } = build({ placedAt });

    await service.createForOrderTx(tx as any, ORG, 'order_1', {});

    const data = tx.invoice.create.mock.calls[0][0].data;
    expect(data.invoiceDate).toEqual(placedAt);
    expect(data.financialYear).toBe('2026-27');
    expect(invoiceNumber.getNextInvoiceNumber).toHaveBeenCalledWith(
      ORG,
      '2026-27',
      tx,
    );
  });

  it('draws the serial from the financial year the invoice is DATED in', async () => {
    // Placed 30 March, invoiced on 8 April: still within the window, so the
    // old year's series, not the new one.
    jest.setSystemTime(new Date('2026-04-08T09:00:00.000Z'));
    const { service, tx, invoiceNumber } = build({
      placedAt: new Date('2026-03-30T10:00:00.000Z'),
    });

    await service.createForOrderTx(tx as any, ORG, 'order_1', {});

    expect(invoiceNumber.getNextInvoiceNumber).toHaveBeenCalledWith(
      ORG,
      '2025-26',
      tx,
    );
  });

  it('dates an order older than the previous period today, without consulting filings', async () => {
    // Placed 30 March, invoiced in October. The CRM cannot know whether the
    // merchant filed March on the portal, so it must not mint into it.
    const { service, tx, warn, invoiceNumber } = build({
      placedAt: new Date('2026-03-30T10:00:00.000Z'),
    });

    await service.createForOrderTx(tx as any, ORG, 'order_1', {});

    const data = tx.invoice.create.mock.calls[0][0].data;
    expect(data.invoiceDate).toEqual(NOW);
    expect(invoiceNumber.getNextInvoiceNumber).toHaveBeenCalledWith(ORG, '2026-27', tx);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/older than the previous GST period/));
    // Only today's period is checked (the lock assertion on the final date);
    // the supply month is never consulted.
    const periodsLookedUp = tx.gstFiling.findFirst.mock.calls.map(
      (c: any) => c[0].where.period.in[0],
    );
    expect(periodsLookedUp).toEqual(['10']);
  });

  it('dates a late invoice today when the order month is already filed', async () => {
    const { service, tx, warn } = build({
      placedAt: new Date('2026-09-25T10:00:00.000Z'),
      // First lookup (September) is filed; second (October, after the fallback)
      // is open.
      filings: [
        {
          returnType: 'GSTR1',
          period: '09',
          filedAt: new Date('2026-10-05T00:00:00.000Z'),
          arn: null,
        },
        null,
      ],
    });

    await service.createForOrderTx(tx as any, ORG, 'order_1', {});

    const data = tx.invoice.create.mock.calls[0][0].data;
    expect(data.invoiceDate).toEqual(NOW);
    expect(data.financialYear).toBe('2026-27');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already filed/));
    expect(tx.gstFiling.findFirst).toHaveBeenCalledTimes(2);
  });
});

/**
 * Editing an issued invoice.
 *
 * Only the buyer block and the notes are editable, and only while the period
 * is open. The write is status-guarded and leaves a timeline event, because a
 * statutory document changed after issue needs a who-and-what.
 */
describe('InvoiceService.update', () => {
  const ORG = 'org_1';
  const ID = 'inv_1';

  function build(
    opts: { status?: InvoiceStatus; filing?: object | null; buyerGstin?: string | null } = {},
  ) {
    const updates: any[] = [];
    const events: any[] = [];
    const tx = {
      invoice: {
        updateMany: jest.fn((args: any) => {
          updates.push(args);
          return Promise.resolve({ count: 1 });
        }),
      },
      orderTimelineEvent: {
        create: jest.fn((args: any) => {
          events.push(args);
          return Promise.resolve({});
        }),
      },
    };
    const prisma = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue({
          status: opts.status ?? InvoiceStatus.ISSUED,
          invoiceDate: new Date('2026-09-25T10:00:00.000Z'),
          sellerGstinId: 'gstin_1',
          orderId: 'order_1',
          invoiceNumber: 'INV-26-27/000036',
          buyerName: 'Test Er',
          buyerGstin: opts.buyerGstin ?? null,
          buyerAddress: null,
          notes: null,
          id: ID,
          order: { id: 'order_1' },
        }),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata', gstEnabled: true }),
      },
      gstFiling: { findFirst: jest.fn().mockResolvedValue(opts.filing ?? null) },
      $transaction: jest.fn((fn: any) => fn(tx)),
    };
    const service = new InvoiceService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, { invoiceIssued: jest.fn() } as any,
    );
    return { service, prisma, updates, events };
  }

  it('rejects a blank buyer name before anything is written', async () => {
    const { service, updates } = build();
    await expect(
      service.update(ID, ORG, { buyerName: '   ' }, 'user_1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it('writes nothing and logs nothing when the values already match', async () => {
    // The page sends every editable field on every save; an unchanged save
    // must not produce an audit event that claims an edit happened.
    const { service, prisma, updates, events } = build();
    await service.update(
      ID,
      ORG,
      { buyerName: ' Test Er ', buyerGstin: '', buyerAddress: { city: '' }, notes: null },
      'user_1',
    );
    expect(updates).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('records only the fields that actually changed', async () => {
    const { service, updates, events } = build();
    await service.update(
      ID,
      ORG,
      { buyerName: 'Test Er', buyerGstin: null, buyerAddress: null, notes: 'Paid by UPI' },
      'user_1',
    );
    expect(updates[0].data).toEqual({ notes: 'Paid by UPI' });
    expect(events[0].data.message).toBe('Invoice INV-26-27/000036 edited: notes');
  });

  it('refuses anything but an issued invoice', async () => {
    const { service } = build({ status: InvoiceStatus.CANCELLED });
    await expect(
      service.update(ID, ORG, { notes: 'x' }, 'user_1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses once the period is filed', async () => {
    const { service, updates } = build({
      filing: { returnType: 'GSTR1', period: '09', filedAt: new Date(), arn: null },
    });
    await expect(
      service.update(ID, ORG, { notes: 'x' }, 'user_1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updates).toHaveLength(0);
  });

  it('normalises the GSTIN, derives the buyer state from it, and logs the edit', async () => {
    const { service, updates, events } = build();
    await service.update(
      ID,
      ORG,
      { buyerGstin: ' 29aabct1332l1zn ', buyerAddress: { city: ' Bengaluru ', zip: '' } },
      'user_1',
    );

    const { where, data } = updates[0];
    expect(where.status).toBe(InvoiceStatus.ISSUED);
    expect(data.buyerGstin).toBe('29AABCT1332L1ZN');
    expect(data.buyerStateCode).toBe('29');
    expect(data.buyerStateName).toBe('Karnataka');
    // Trimmed, blanks dropped, plain object.
    expect(data.buyerAddress).toEqual({ city: 'Bengaluru' });
    expect(events[0].data.actorId).toBe('user_1');
    expect(events[0].data.message).toMatch(/INV-26-27\/000036 edited: buyer GSTIN, buyer address/);
  });

  it('clears the GSTIN on an empty string and rejects a malformed one', async () => {
    const { service, updates } = build({ buyerGstin: '27AAPFU0939F1ZV' });
    await service.update(ID, ORG, { buyerGstin: '' }, 'user_1');
    expect(updates[0].data.buyerGstin).toBeNull();

    await expect(
      service.update(ID, ORG, { buyerGstin: 'NOT-A-GSTIN' }, 'user_1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * Bulk issue from the Orders list.
 *
 * Numbering is read-max-then-increment, so the batch must run one order at a
 * time — and one bad order must not take the others down with it.
 */
describe('InvoiceService.bulkCreate', () => {
  const ORG = 'org_1';

  const order = (
    id: string,
    over: Partial<{
      financialStatus: string;
      cancelledAt: Date | null;
      createdAt: Date;
      orderNumber: number;
      invoices: Array<{ invoiceNumber: string }>;
    }> = {},
  ) => ({
    id,
    name: `#${id}`,
    orderNumber: over.orderNumber ?? 1,
    financialStatus: over.financialStatus ?? 'PAID',
    cancelledAt: over.cancelledAt ?? null,
    externalCreatedAt: null,
    createdAt: over.createdAt ?? new Date('2026-10-01T00:00:00Z'),
    invoices: over.invoices ?? [],
  });

  function build(
    orders: ReturnType<typeof order>[],
    opts: { gstEnabled?: boolean; failFor?: Record<string, Error>; liveAfterFail?: string[] } = {},
  ) {
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ gstEnabled: opts.gstEnabled ?? true }),
      },
      order: { findMany: jest.fn().mockResolvedValue(orders) },
      invoice: {
        findFirst: jest.fn((args: any) =>
          Promise.resolve(
            opts.liveAfterFail?.includes(args.where.orderId)
              ? { invoiceNumber: 'INV-26-27/000099' }
              : null,
          ),
        ),
      },
    };
    const service = new InvoiceService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, { invoiceIssued: jest.fn() } as any,
    );
    let n = 0;
    const create = jest.spyOn(service, 'create').mockImplementation(async (_org, dto) => {
      const err = opts.failFor?.[dto.orderId];
      if (err) throw err;
      n += 1;
      return {
        id: `inv_${dto.orderId}`,
        invoiceNumber: `INV-26-27/${String(n).padStart(6, '0')}`,
        invoiceDate: new Date('2026-10-01T00:00:00Z'),
      } as any;
    });
    return { service, prisma, create };
  }

  it('issues eligible orders and skips the rest with a reason', async () => {
    const { service } = build([
      order('paid'),
      order('done', { invoices: [{ invoiceNumber: 'INV-26-27/000001' }] }),
      order('gone', { cancelledAt: new Date() }),
      order('cod', { financialStatus: 'PENDING' }),
    ]);

    const res = await service.bulkCreate(ORG, ['paid', 'done', 'gone', 'cod', 'missing']);

    expect(res.issued.map((i) => i.orderId)).toEqual(['paid']);
    expect(res.failed).toEqual([]);
    expect(Object.fromEntries(res.skipped.map((s) => [s.orderId, s.reason]))).toEqual({
      done: 'Already invoiced (INV-26-27/000001)',
      gone: 'Order is cancelled',
      cod: 'Not paid (pending)',
      missing: 'Order not found',
    });
  });

  it('issues oldest supply date first so serials rise with invoice dates', async () => {
    const { service, create } = build([
      order('new', { createdAt: new Date('2026-10-05T00:00:00Z'), orderNumber: 3 }),
      order('old', { createdAt: new Date('2026-10-01T00:00:00Z'), orderNumber: 1 }),
      order('mid', { createdAt: new Date('2026-10-03T00:00:00Z'), orderNumber: 2 }),
    ]);

    await service.bulkCreate(ORG, ['new', 'old', 'mid']);

    expect(create.mock.calls.map(([, dto]) => dto.orderId)).toEqual(['old', 'mid', 'new']);
  });

  it('keeps going when one order is rejected, and reports why', async () => {
    const { service } = build([order('a'), order('b'), order('c')], {
      failFor: { b: new BadRequestException('No GSTIN registration found.') },
    });

    const res = await service.bulkCreate(ORG, ['a', 'b', 'c']);

    expect(res.issued.map((i) => i.orderId)).toEqual(['a', 'c']);
    expect(res.failed).toEqual([
      { orderId: 'b', orderName: '#b', reason: 'No GSTIN registration found.' },
    ]);
  });

  it('reports an order invoiced concurrently as skipped, not failed', async () => {
    const { service } = build([order('a')], {
      failFor: { a: new ConflictException('Invoice INV-26-27/000099 already exists') },
      liveAfterFail: ['a'],
    });

    const res = await service.bulkCreate(ORG, ['a']);

    expect(res.failed).toEqual([]);
    expect(res.skipped).toEqual([
      { orderId: 'a', orderName: '#a', reason: 'Already invoiced (INV-26-27/000099)' },
    ]);
  });

  it('still returns the batch when the post-failure lookup itself fails', async () => {
    const { service, prisma } = build([order('a'), order('b')], {
      failFor: { a: new BadRequestException('No GSTIN registration found.') },
    });
    prisma.invoice.findFirst.mockRejectedValueOnce(new Error('connection reset'));

    const res = await service.bulkCreate(ORG, ['a', 'b']);

    expect(res.issued.map((i) => i.orderId)).toEqual(['b']);
    expect(res.failed).toEqual([
      { orderId: 'a', orderName: '#a', reason: 'No GSTIN registration found.' },
    ]);
  });

  it('refuses the whole batch when GST is off, issuing nothing', async () => {
    const { service, create } = build([order('a')], { gstEnabled: false });

    await expect(service.bulkCreate(ORG, ['a'])).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});
