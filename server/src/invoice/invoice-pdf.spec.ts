import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvoiceService } from './invoice.service';
import type { DocumentModel } from './render/document-model';
import { renderDocumentPdf } from './render/document-pdf';

// The renderer is drawn on its own branch; this checks what pdf() hands it.
jest.mock('./render/document-pdf', () => ({ renderDocumentPdf: jest.fn() }));
const render = renderDocumentPdf as jest.Mock;
const drawn = () => (render.mock.calls[0] as [DocumentModel])[0];

/** `InvoiceService.pdf`: the invoice's rows, built into a document, drawn, and named. */

const d = (v: string | number) => new Prisma.Decimal(v);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const row = (over: Record<string, unknown> = {}) => ({
  invoiceNumber: 'INV-26-27/000124',
  invoiceDate: new Date('2026-10-26T20:00:00Z'),
  status: 'ISSUED',
  cancelledAt: null,
  currency: 'INR',
  gstType: 'CGST_SGST',
  reverseCharge: false,
  sellerLegalName: 'Saanjh Apparel Private Limited',
  sellerGstin: '29ABCDE1234F1Z5',
  sellerAddress: { address1: 'No. 12, 100 Feet Road', city: 'Bengaluru' },
  sellerStateCode: '29',
  sellerStateName: 'Karnataka',
  dispatchName: null,
  dispatchAddress: null,
  buyerName: 'Walk-in customer',
  buyerGstin: null,
  buyerAddress: null,
  buyerStateCode: '29',
  buyerStateName: 'Karnataka',
  placeOfSupply: '29',
  placeOfSupplyName: 'Karnataka',
  subtotal: d('1900'),
  totalCgst: d('47.50'),
  totalSgst: d('47.50'),
  totalIgst: d('0'),
  shippingCharge: d('0'),
  grandTotal: d('1995'),
  notes: null,
  creditNoteReason: null,
  metadata: null,
  creditNoteFor: null,
  lineItems: [
    {
      orderLineItemId: 'oli_1',
      description: 'Linen shirt - M',
      hsnCode: '6205',
      unitOfMeasure: null,
      quantity: 2,
      unitPrice: d('1000'),
      discount: d('100'),
      taxableValue: d('1900'),
      gstRate: d('5'),
      cgstRate: d('2.5'),
      cgstAmount: d('47.50'),
      sgstRate: d('2.5'),
      sgstAmount: d('47.50'),
      igstRate: d('0'),
      igstAmount: d('0'),
      totalAmount: d('1995'),
    },
  ],
  order: {
    name: '#M1001',
    createdAt: new Date('2026-10-26T20:00:00Z'),
    externalCreatedAt: null,
    financialStatus: 'PAID',
    paymentGateways: [],
    posSale: true,
    metadata: { paymentMethod: 'CASH' },
    shippingAddress: null,
    customer: null,
    lineItems: [
      { id: 'oli_1', title: 'Linen shirt', variantTitle: 'M', sku: 'LS-M' },
    ],
    fulfillments: [],
    payments: [
      {
        method: 'CASH',
        amount: d('1995'),
        reference: null,
        createdAt: new Date('2026-10-26T20:01:00Z'),
      },
    ],
    paymentLinks: [],
    timeline: [],
  },
  ...over,
});

function service(
  invoice: Record<string, unknown> | null,
  storeProfileSettings: Record<string, unknown> | null = null,
) {
  const images = {
    read: jest.fn((key: string) =>
      key === 'org_1/logo.png'
        ? Promise.resolve(PNG)
        : Promise.reject(new NotFoundException('Image not found')),
    ),
  };
  const prisma = {
    invoice: { findFirst: jest.fn().mockResolvedValue(invoice) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'Saanjh',
        website: null,
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        gstEnabled: true,
      }),
    },
    organizationSettings: {
      findUnique: jest.fn().mockResolvedValue({
        taxSettings: { defaultUnitOfMeasure: 'PCS' },
        invoiceSettings: null,
        storeProfileSettings,
        posSettings: null,
      }),
    },
  };
  return {
    invoices: new InvoiceService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      images as never,
    ),
    prisma,
    images,
  };
}

describe('InvoiceService.pdf', () => {
  beforeEach(() =>
    render.mockReset().mockResolvedValue(Buffer.from('%PDF-1.7 invoice')),
  );

  it('draws the invoice as its document, and names the file after its number', async () => {
    const { invoices } = service(row());
    await expect(invoices.pdf('inv_1', 'org_1')).resolves.toEqual({
      buffer: Buffer.from('%PDF-1.7 invoice'),
      filename: 'INV-26-27-000124.pdf',
      invoiceNumber: 'INV-26-27/000124',
    });
    expect(drawn()).toMatchObject({
      kind: 'TAX_INVOICE',
      title: 'TAX INVOICE',
      documentNumber: 'INV-26-27/000124',
      taxHeads: 'CGST_SGST',
      status: {
        chip: { text: 'PAID', tone: 'paid' },
        line: 'Paid on 27 Oct 2026',
        note: 'Cash',
      },
      lines: [
        {
          name: 'Linen shirt',
          detail: 'M · LS-M',
          quantity: '2 PCS',
          cgst: { amount: 47.5, rate: 2.5 },
          sgst: { amount: 47.5, rate: 2.5 },
          amount: 1995,
        },
      ],
      totals: {
        itemValue: 2000,
        discount: 100,
        taxable: 1900,
        cgst: 47.5,
        sgst: 47.5,
        grandTotal: 1995,
      },
      payment: {
        kind: 'received',
        lines: ['Cash · 27 Oct 2026, 01:31 · ₹1,995.00'],
      },
    });
  });

  it('embeds the uploaded logo, read through the image storage', async () => {
    const { invoices, images } = service(row(), {
      logoStorageKey: 'org_1/logo.png',
    });
    await invoices.pdf('inv_1', 'org_1');
    expect(images.read).toHaveBeenCalledWith('org_1/logo.png');
    expect(drawn().seller.logo).toEqual({ data: PNG, format: 'png' });
  });

  it('a credit note is drawn as one, from the invoice it reverses', async () => {
    const { invoices } = service(
      row({
        invoiceNumber: 'CN-26-27/000009',
        status: 'CREDIT_NOTE',
        creditNoteFor: {
          invoiceNumber: 'INV-26-27/000124',
          invoiceDate: new Date('2026-10-26T20:00:00Z'),
        },
      }),
    );
    const { filename } = await invoices.pdf('cn_1', 'org_1');
    expect(filename).toBe('CN-26-27-000009.pdf');
    expect(drawn()).toMatchObject({
      kind: 'CREDIT_NOTE',
      title: 'CREDIT NOTE',
      reference: ['Against invoice INV-26-27/000124 dated 27 Oct 2026'],
    });
  });

  it('another organization’s invoice is not found, and nothing is drawn', async () => {
    const { invoices, prisma } = service(null);
    await expect(invoices.pdf('inv_x', 'org_1')).rejects.toThrow(
      new NotFoundException('Invoice not found'),
    );
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv_x', organizationId: 'org_1' },
      }),
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('a renderer failure reaches the caller, which decides what to send instead', async () => {
    render.mockRejectedValueOnce(new Error('layout failed'));
    await expect(service(row()).invoices.pdf('inv_1', 'org_1')).rejects.toThrow(
      'layout failed',
    );
  });
});
