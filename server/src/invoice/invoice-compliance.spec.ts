import { BadRequestException } from '@nestjs/common';
import { GstCalculatorService } from '../gst/gst-calculator.service';
import { readRenderSnapshot } from './render/render-snapshot';
import { InvoiceService } from './invoice.service';

/**
 * What an issued document keeps besides its statutory columns, and the
 * documents Collabo must refuse to issue at all.
 *
 * A composition seller issues bills of supply and cannot sell to another
 * state. With e-invoicing on, invoices and credit notes to GST-registered
 * buyers, and exports, need an IRN Collabo cannot get yet; anything issued
 * without one "shall not be treated as an invoice" (Rule 48(5)). Both
 * refusals come before a number is drawn, so the series stays gapless.
 */

const ORG = 'org_1';
const BUYER_GSTIN = '29AAGCB7383J1Z4';
const COMPOSITION_REFUSAL =
  "You're registered under the GST composition scheme, which doesn't allow sales to another state. " +
  "This sale's place of supply is Kerala (32); your registration is in Karnataka (29).";
const INVOICE_REFUSAL =
  "E-invoicing is on for your business, so invoices to GST-registered buyers and exports need an IRN from " +
  "the government's e-invoice portal, which Collabo can't get yet. Issue this one on the e-invoice portal or " +
  'in your accounting software.';
const CREDIT_NOTE_REFUSAL =
  "E-invoicing is on for your business, so credit notes to GST-registered buyers and exports need an IRN from " +
  "the government's e-invoice portal, which Collabo can't get yet. Issue this one on the e-invoice portal or " +
  'in your accounting software.';
const EDIT_REFUSAL =
  "E-invoicing is on for your business, so invoices to GST-registered buyers need an IRN from " +
  "the government's e-invoice portal, which Collabo can't get yet. To put the buyer's GSTIN on it, cancel this " +
  'invoice and issue the corrected one on the e-invoice portal or in your accounting software.';

const SETTINGS = {
  invoiceSettings: { theme: 'classic', brandColor: '#1F6F5C', terms: 'Goods once sold are exchanged within 7 days.' },
  storeProfileSettings: {
    storeName: '  Saanjh  ',
    supportPhone: '+91 80 4000 0000',
    whatsappPhone: '+91 98450 00000',
    supportEmail: 'care@saanjh.in',
    logoUrl: 'http://api.test/uploads/products/org_1/logo.png',
    logoStorageKey: 'org_1/logo.png',
  },
  posSettings: { upiId: 'saanjh@okhdfc' },
};

/** A line as the order read returns it; `supplyType` classifies the product. */
const line = (id: string, supplyType: string | null = null) => ({
  id,
  title: 'Cotton Shirt',
  variantTitle: null,
  price: '1000.00',
  quantity: 1,
  totalDiscount: '0.00',
  taxable: true,
  variant: {
    gstRate: null,
    taxable: true,
    hsnCode: null,
    unitOfMeasure: null,
    supplyType: null,
    product: { id: `p_${id}`, hsnCode: '6109', gstRate: null, supplyType, unitOfMeasure: null },
  },
});

describe('InvoiceService.createForOrderTx compliance', () => {
  function build(opts: {
    tax?: Record<string, unknown>;
    settings?: Record<string, unknown> | null;
    placeOfSupplyCode?: string;
    customerGstin?: string | null;
    lineItems?: object[];
    rates?: number[];
  } = {}) {
    const lineItems = opts.lineItems ?? [line('li_1')];
    const order = {
      id: 'order_1',
      organizationId: ORG,
      externalCreatedAt: new Date('2026-10-20T10:00:00.000Z'),
      createdAt: new Date('2026-10-20T10:00:00.000Z'),
      currency: 'INR',
      totalTax: '0.00',
      taxesIncluded: false,
      sourceName: null,
      totalShippingPrice: '0.00',
      billingAddress: null,
      dispatchWarehouseId: null,
      placeOfSupplyCode: opts.placeOfSupplyCode ?? '29',
      customer: opts.customerGstin
        ? { id: 'cust_1', firstName: 'Meera', lastName: 'Traders', email: null, gstin: opts.customerGstin, billingStateCode: '29' }
        : null,
      channel: { platform: 'MANUAL' },
      lineItems,
    };
    const tx = {
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      invoice: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...data, lineItems: [] }),
        ),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          gstEnabled: true,
          timezone: 'Asia/Kolkata',
          name: 'Saanjh Retail Private Limited',
          website: 'https://saanjh.in',
        }),
      },
      organizationSettings: {
        findUnique: jest.fn().mockResolvedValue(
          opts.settings === null ? null : { taxSettings: opts.tax ?? {}, ...(opts.settings ?? SETTINGS) },
        ),
      },
      organizationGstin: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'gstin_1',
          gstin: '29AABCT1332L1ZN',
          legalName: 'Saanjh Retail Private Limited',
          address: null,
          stateCode: '29',
          stateName: 'Karnataka',
        }),
      },
      warehouse: { findFirst: jest.fn().mockResolvedValue(null) },
      gstFiling: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const invoiceNumber = { getNextInvoiceNumber: jest.fn().mockResolvedValue('INV-26-27/000001') };
    const service = new InvoiceService(
      {} as never,
      {} as never,
      new GstCalculatorService(),
      { resolveLineGstRates: jest.fn().mockResolvedValue(opts.rates ?? lineItems.map(() => 18)) } as never,
      invoiceNumber as never,
      { invoiceIssued: jest.fn() } as never,
      {} as never,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    const issue = async (dto: { buyerGstin?: string } = {}) => {
      await service.createForOrderTx(tx as never, ORG, 'order_1', dto);
      return tx.invoice.create.mock.calls[0][0].data;
    };
    return { service, tx, invoiceNumber, issue };
  }

  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-27T09:00:00.000Z') }));
  afterEach(() => jest.useRealTimers());

  it('keeps the design, brand and UPI id the invoice was issued with', async () => {
    const data = await build().issue();

    const snapshot = readRenderSnapshot(data.metadata);
    expect(snapshot).toMatchObject({
      v: 1,
      documentType: 'TAX_INVOICE',
      composition: false,
      eInvoiceDeclaration: false,
      design: {
        theme: 'classic',
        brandColor: '#1F6F5C',
        terms: 'Goods once sold are exchanged within 7 days.',
        footerNote: 'Thank you for shopping with us.',
      },
    });
    expect(snapshot?.brand).toEqual({
      tradeName: 'Saanjh',
      logoStorageKey: 'org_1/logo.png',
      supportPhone: '+91 80 4000 0000',
      whatsappPhone: '+91 98450 00000',
      supportEmail: 'care@saanjh.in',
      website: 'https://saanjh.in',
      upiId: 'saanjh@okhdfc',
    });
  });

  it('falls back to the organization for an org that has saved no settings', async () => {
    const data = await build({ settings: null }).issue();

    expect(readRenderSnapshot(data.metadata)?.brand).toEqual({
      tradeName: 'Saanjh Retail Private Limited',
      logoStorageKey: null,
      supportPhone: '',
      whatsappPhone: '',
      supportEmail: '',
      website: 'https://saanjh.in',
      upiId: null,
    });
  });

  it('issues a composition sale within the state as a bill of supply', async () => {
    const data = await build({ tax: { composition: true }, rates: [0] }).issue();

    expect(readRenderSnapshot(data.metadata)).toEqual(
      expect.objectContaining({ documentType: 'BILL_OF_SUPPLY', composition: true, eInvoiceDeclaration: false }),
    );
    expect(data.totalTax).toBe(0);
  });

  it('issues a bill of supply when every line is exempt, nil-rated or non-GST (Rule 49)', async () => {
    const data = await build({
      lineItems: [line('li_1', 'EXEMPT'), line('li_2', 'NIL_RATED'), line('li_3', 'NON_GST')],
      rates: [0, 0, 0],
    }).issue();

    expect(readRenderSnapshot(data.metadata)).toEqual(
      expect.objectContaining({ documentType: 'BILL_OF_SUPPLY', composition: false }),
    );
  });

  it('issues a tax invoice when any line is taxable', async () => {
    const data = await build({
      lineItems: [line('li_1', 'EXEMPT'), line('li_2', 'TAXABLE')],
      rates: [0, 18],
    }).issue();

    expect(readRenderSnapshot(data.metadata)?.documentType).toBe('TAX_INVOICE');
  });

  it('refuses a composition sale to another state before drawing a number', async () => {
    const { issue, tx, invoiceNumber } = build({ tax: { composition: true }, placeOfSupplyCode: '32' });

    await expect(issue()).rejects.toThrow(COMPOSITION_REFUSAL);
    expect(invoiceNumber.getNextInvoiceNumber).not.toHaveBeenCalled();
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it('refuses a composition export: it is a sale to another state', async () => {
    const { issue } = build({ tax: { composition: true }, placeOfSupplyCode: '96' });

    await expect(issue()).rejects.toThrow(
      "This sale's place of supply is Other Country (96); your registration is in Karnataka (29).",
    );
  });

  it('refuses an invoice to a GST-registered buyer with e-invoicing on, before drawing a number', async () => {
    const { issue, tx, invoiceNumber } = build({ tax: { eInvoicing: true }, customerGstin: BUYER_GSTIN });

    const refusal = issue();
    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toThrow(INVOICE_REFUSAL);
    expect(invoiceNumber.getNextInvoiceNumber).not.toHaveBeenCalled();
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it('refuses one made B2B by a GSTIN typed when issuing', async () => {
    const { issue, invoiceNumber } = build({ tax: { eInvoicing: true } });

    await expect(issue({ buyerGstin: BUYER_GSTIN })).rejects.toThrow(INVOICE_REFUSAL);
    expect(invoiceNumber.getNextInvoiceNumber).not.toHaveBeenCalled();
  });

  it('refuses an export with e-invoicing on, even to an unregistered buyer', async () => {
    const { issue } = build({ tax: { eInvoicing: true }, placeOfSupplyCode: '96' });

    await expect(issue()).rejects.toThrow(INVOICE_REFUSAL);
  });

  it('issues a B2C invoice with e-invoicing on, carrying the Rule 46(s) declaration', async () => {
    const data = await build({ tax: { eInvoicing: true } }).issue();

    expect(readRenderSnapshot(data.metadata)).toEqual(
      expect.objectContaining({ documentType: 'TAX_INVOICE', eInvoiceDeclaration: true }),
    );
  });

  it('issues to a GST-registered buyer as before while e-invoicing is off', async () => {
    const data = await build({ customerGstin: BUYER_GSTIN }).issue();

    expect(data.buyerGstin).toBe(BUYER_GSTIN);
    expect(readRenderSnapshot(data.metadata)?.eInvoiceDeclaration).toBe(false);
  });
});

describe('InvoiceService credit notes, compliance', () => {
  function build(opts: {
    tax?: Record<string, unknown>;
    buyerGstin?: string | null;
    placeOfSupply?: string;
    originalMetadata?: unknown;
  } = {}) {
    const original = {
      id: 'inv_1',
      organizationId: ORG,
      orderId: 'order_1',
      status: 'ISSUED',
      sellerGstinId: 'gstin_1',
      invoiceNumber: 'INV-26-27/000001',
      grandTotal: '1000.00',
      subtotal: '1000.00',
      totalCgst: '0.00',
      totalSgst: '0.00',
      totalIgst: '0.00',
      totalTax: '0.00',
      totalDiscount: '0.00',
      shippingCharge: '0.00',
      currency: 'INR',
      gstType: 'CGST_SGST',
      reverseCharge: false,
      buyerGstin: opts.buyerGstin ?? null,
      placeOfSupply: opts.placeOfSupply ?? '29',
      metadata: opts.originalMetadata ?? null,
      lineItems: [
        {
          orderLineItemId: 'li_1',
          description: 'Cotton Shirt',
          hsnCode: '6109',
          unitOfMeasure: 'NOS',
          supplyType: 'TAXABLE',
          quantity: 1,
          unitPrice: '1000.00',
          discount: '0.00',
          taxableValue: '1000.00',
          gstRate: '0.00',
          cgstRate: '0.00',
          cgstAmount: '0.00',
          sgstRate: '0.00',
          sgstAmount: '0.00',
          igstRate: '0.00',
          igstAmount: '0.00',
          totalTax: '0.00',
          totalAmount: '1000.00',
        },
      ],
    };
    const tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(original),
        aggregate: jest.fn().mockResolvedValue({ _sum: { grandTotal: null, subtotal: null, totalTax: null } }),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(data)),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          gstEnabled: true,
          timezone: 'Asia/Kolkata',
          name: 'Saanjh Retail Private Limited',
          website: null,
          settings: { taxSettings: opts.tax ?? {}, ...SETTINGS },
        }),
      },
      gstFiling: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const invoiceNumber = { getNextCreditNoteNumber: jest.fn().mockResolvedValue('CN-26-27/000001') };
    const service = new InvoiceService(
      {} as never,
      {} as never,
      new GstCalculatorService(),
      {} as never,
      invoiceNumber as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    const raise = async () => {
      await service['createCreditNoteTx'](tx as never, ORG, 'inv_1', { reason: 'Goods returned' });
      return tx.invoice.create.mock.calls[0][0].data;
    };
    return { raise, tx, invoiceNumber };
  }

  const billOfSupply = {
    render: {
      v: 1,
      documentType: 'BILL_OF_SUPPLY',
      composition: true,
      eInvoiceDeclaration: false,
      design: { theme: 'modern' },
      brand: {
        tradeName: 'Saanjh (old name)',
        logoStorageKey: null,
        supportPhone: '',
        whatsappPhone: '',
        supportEmail: '',
        website: '',
        upiId: null,
      },
    },
  };

  it('keeps the tax treatment of the invoice it reverses, after the merchant left the scheme', async () => {
    const data = await build({ originalMetadata: billOfSupply }).raise();

    const snapshot = readRenderSnapshot(data.metadata);
    expect(snapshot).toEqual(
      expect.objectContaining({ documentType: 'BILL_OF_SUPPLY', composition: true, eInvoiceDeclaration: false }),
    );
    // The design and brand are today's, as on any new document.
    expect(snapshot?.design.theme).toBe('classic');
    expect(snapshot?.brand.tradeName).toBe('Saanjh');
  });

  it('treats an invoice issued before snapshots as a tax invoice', async () => {
    const data = await build().raise();

    expect(readRenderSnapshot(data.metadata)).toEqual(
      expect.objectContaining({ documentType: 'TAX_INVOICE', composition: false }),
    );
  });

  it('refuses a credit note to a GST-registered buyer with e-invoicing on, before drawing a number', async () => {
    const { raise, tx, invoiceNumber } = build({ tax: { eInvoicing: true }, buyerGstin: BUYER_GSTIN });

    await expect(raise()).rejects.toThrow(CREDIT_NOTE_REFUSAL);
    expect(invoiceNumber.getNextCreditNoteNumber).not.toHaveBeenCalled();
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it('refuses a credit note against an export with e-invoicing on, before drawing a number', async () => {
    const { raise, tx, invoiceNumber } = build({ tax: { eInvoicing: true }, placeOfSupply: '96' });

    await expect(raise()).rejects.toThrow(CREDIT_NOTE_REFUSAL);
    expect(invoiceNumber.getNextCreditNoteNumber).not.toHaveBeenCalled();
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it('raises a credit note against an export while e-invoicing is off', async () => {
    const data = await build({ placeOfSupply: '96' }).raise();

    expect(data.placeOfSupply).toBe('96');
    expect(readRenderSnapshot(data.metadata)?.eInvoiceDeclaration).toBe(false);
  });

  it('raises a B2C credit note with e-invoicing on, carrying the declaration', async () => {
    const data = await build({ tax: { eInvoicing: true } }).raise();

    expect(readRenderSnapshot(data.metadata)?.eInvoiceDeclaration).toBe(true);
  });

  it('raises a credit note to a GST-registered buyer while e-invoicing is off', async () => {
    const data = await build({ buyerGstin: BUYER_GSTIN }).raise();

    expect(data.buyerGstin).toBe(BUYER_GSTIN);
    expect(readRenderSnapshot(data.metadata)?.eInvoiceDeclaration).toBe(false);
  });
});

/**
 * Editing an issued invoice must not turn it into one Collabo could not have
 * issued: with e-invoicing on, a buyer GSTIN makes it a B2B invoice that
 * needs an IRN. Clearing a GSTIN, and every edit with the switch off, work as
 * before.
 */
describe('InvoiceService.update under e-invoicing', () => {
  const ID = 'inv_1';
  const OTHER_GSTIN = '27AAPFU0939F1ZV';

  function build(opts: { eInvoicing: boolean; buyerGstin?: string | null }) {
    const tx = {
      invoice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue({
          id: ID,
          status: 'ISSUED',
          invoiceDate: new Date('2026-10-20T10:00:00.000Z'),
          sellerGstinId: 'gstin_1',
          orderId: 'order_1',
          invoiceNumber: 'INV-26-27/000036',
          buyerName: 'Meera Traders',
          buyerGstin: opts.buyerGstin ?? null,
          buyerAddress: null,
          notes: null,
        }),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          timezone: 'Asia/Kolkata',
          gstEnabled: true,
          settings: { taxSettings: { eInvoicing: opts.eInvoicing } },
        }),
      },
      gstFiling: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const service = new InvoiceService(
      prisma as never,
      {} as never,
      new GstCalculatorService(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const written = () => tx.invoice.updateMany.mock.calls as Array<[{ data: Record<string, unknown> }]>;
    return { service, tx, written };
  }

  it('refuses adding a GSTIN to a B2C invoice, writing nothing', async () => {
    const { service, tx } = build({ eInvoicing: true });

    const refusal = service.update(ID, ORG, { buyerGstin: BUYER_GSTIN }, 'user_1');
    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toThrow(EDIT_REFUSAL);
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(tx.orderTimelineEvent.create).not.toHaveBeenCalled();
  });

  it('refuses changing the GSTIN on an invoice issued before the switch was turned on', async () => {
    const { service, tx } = build({ eInvoicing: true, buyerGstin: OTHER_GSTIN });

    await expect(service.update(ID, ORG, { buyerGstin: BUYER_GSTIN }, 'user_1')).rejects.toThrow(EDIT_REFUSAL);
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('still clears a GSTIN', async () => {
    const { service, written } = build({ eInvoicing: true, buyerGstin: BUYER_GSTIN });

    await service.update(ID, ORG, { buyerGstin: '' }, 'user_1');

    expect(written()[0][0].data).toEqual({ buyerGstin: null });
  });

  it('still takes the other edits, and the same GSTIN sent back with them', async () => {
    const { service, written } = build({ eInvoicing: true, buyerGstin: BUYER_GSTIN });

    await service.update(ID, ORG, { buyerName: 'Meera Traders LLP', buyerGstin: BUYER_GSTIN.toLowerCase(), notes: 'PO 4471' }, 'user_1');

    expect(written()[0][0].data).toEqual({ buyerName: 'Meera Traders LLP', notes: 'PO 4471' });
  });

  it('adds or changes a GSTIN as before while e-invoicing is off', async () => {
    const added = build({ eInvoicing: false });
    await added.service.update(ID, ORG, { buyerGstin: BUYER_GSTIN }, 'user_1');
    expect(added.written()[0][0].data).toEqual({
      buyerGstin: BUYER_GSTIN,
      buyerStateCode: '29',
      buyerStateName: 'Karnataka',
    });

    const changed = build({ eInvoicing: false, buyerGstin: OTHER_GSTIN });
    await changed.service.update(ID, ORG, { buyerGstin: BUYER_GSTIN }, 'user_1');
    expect(changed.written()[0][0].data).toMatchObject({ buyerGstin: BUYER_GSTIN });
  });
});
