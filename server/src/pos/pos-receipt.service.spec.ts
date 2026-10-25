import { NotFoundException } from '@nestjs/common';
import { GstType, Prisma } from '@prisma/client';
import { PosReceiptService } from './pos-receipt.service';
import { parsePosSettings } from './pos-settings.schema';

/**
 * The receipt's tax figures come from the GST invoice when one was issued,
 * and from what each line was charged otherwise; either way the shape is the
 * same, so a till prints both without knowing which it has.
 */

const d = (v: string | number) => new Prisma.Decimal(v);
const ORG = 'org_1';

const PROFILE = {
    storeName: 'Acme Store', address1: '12 MG Road', address2: '', city: 'Bengaluru', province: 'Karnataka', zip: '560001',
    country: 'India', supportPhone: '+91 80 4000 0000', whatsappPhone: '', supportEmail: '', website: '', logoUrl: '',
};

function line(over: Record<string, unknown> = {}) {
    return {
        id: 'li_1', title: 'Linen shirt', variantTitle: 'M', quantity: 2, price: d('1000'), totalDiscount: d('100'),
        channelTaxAmount: d('95'),
        channelTaxLines: [{ title: 'CGST', rate: 0.025, price: '47.50' }, { title: 'SGST', rate: 0.025, price: '47.50' }],
        variant: { hsnCode: null, product: { hsnCode: '6205' } },
        ...over,
    };
}

function build(order: Record<string, unknown> | null) {
    const prisma: any = {
        order: { findFirst: jest.fn().mockResolvedValue(order) },
        organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme Pvt Ltd', logo: 'https://cdn/logo.png', gstEnabled: true }) },
        organizationGstin: { findFirst: jest.fn().mockResolvedValue({ gstin: '29AAACA1234A1Z5', address: { address1: 'Reg office' } }) },
    };
    const service = new PosReceiptService(
        prisma,
        { getStoreProfileSettings: jest.fn().mockResolvedValue(PROFILE) } as any,
        { settings: jest.fn().mockResolvedValue(parsePosSettings({ receiptWidth: 58, receiptFooter: 'No exchange after 7 days.' })) } as any,
    );
    return { service, prisma };
}

const baseOrder = {
    id: 'order_1', name: '#M1001', createdAt: new Date('2026-10-26T06:30:00Z'), totalPrice: d('1995.00'), taxesIncluded: false,
    metadata: { source: 'offline', pos: { storeId: 'wh_1', roundOff: 0, clientSaleId: 'c1' } },
    posStaff: { name: 'Ravi' },
    dispatchWarehouse: { name: 'MG Road' },
    customer: { firstName: 'Asha', lastName: 'Menon', phone: '+919800000001', gstin: null },
    payments: [
        { method: 'CASH', amount: d('1000'), tendered: d('2000'), reference: null },
        { method: 'UPI', amount: d('995'), tendered: null, reference: 'UTR42' },
    ],
};

describe('PosReceiptService.receipt', () => {
    it('without an invoice: tax from what each line was charged', async () => {
        const { service } = build({ ...baseOrder, lineItems: [line()], invoices: [] });
        const r = await service.receipt(ORG, 'order_1');
        expect(r.width).toBe(58);
        expect(r.footer).toBe('No exchange after 7 days.');
        expect(r.store).toEqual({
            name: 'Acme Store',
            address: '12 MG Road, Bengaluru, Karnataka 560001',
            phone: '+91 80 4000 0000',
            gstin: '29AAACA1234A1Z5',
            logoUrl: 'https://cdn/logo.png',
        });
        expect(r.order).toEqual({ id: 'order_1', name: '#M1001', createdAt: '2026-10-26T06:30:00.000Z', staffName: 'Ravi', storeName: 'MG Road' });
        expect(r.invoice).toBeNull();
        expect(r.customer).toEqual({ name: 'Asha Menon', phone: '+919800000001', gstin: null });
        expect(r.lines).toEqual([
            {
                title: 'Linen shirt', variantTitle: 'M', hsn: '6205', quantity: 2, unitPrice: 1000, discount: 100,
                taxableValue: 1900, gstRate: 5, cgst: 47.5, sgst: 47.5, igst: 0, total: 1995,
            },
        ]);
        expect(r.totals).toEqual({ subtotal: 2000, discount: 100, taxable: 1900, cgst: 47.5, sgst: 47.5, igst: 0, roundOff: 0, total: 1995, payable: 1995 });
        expect(r.gstSummary).toEqual([{ rate: 5, taxable: 1900, cgst: 47.5, sgst: 47.5, igst: 0 }]);
        expect(r.payments).toEqual([
            { method: 'CASH', amount: 1000, tendered: 2000, change: 1000, reference: null },
            { method: 'UPI', amount: 995, tendered: null, change: null, reference: 'UTR42' },
        ]);
        expect(r.paid).toBe(1995);
        expect(r.balanceDue).toBe(0);
    });

    it("with an invoice: the invoice's figures, number, place of supply and tax type", async () => {
        const invoice = {
            invoiceNumber: 'INV-26-27/000007', invoiceDate: new Date('2026-10-26T00:00:00Z'), placeOfSupply: '29', placeOfSupplyName: 'Karnataka',
            gstType: GstType.CGST_SGST, sellerGstin: '29AAACA9999A1Z5', sellerAddress: null,
            lineItems: [{
                orderLineItemId: 'li_1', hsnCode: '6205', taxableValue: d('1900'), gstRate: d('5'),
                cgstAmount: d('47.50'), sgstAmount: d('47.50'), igstAmount: d('0'), totalAmount: d('1995'),
            }],
        };
        const { service } = build({ ...baseOrder, lineItems: [line({ channelTaxLines: null, channelTaxAmount: null })], invoices: [invoice] });
        const r = await service.receipt(ORG, 'order_1');
        expect(r.invoice).toEqual({ number: 'INV-26-27/000007', date: '2026-10-26T00:00:00.000Z', placeOfSupply: 'Karnataka', gstType: 'INTRA' });
        expect(r.store.gstin).toBe('29AAACA9999A1Z5');
        expect(r.lines[0]).toMatchObject({ hsn: '6205', taxableValue: 1900, gstRate: 5, cgst: 47.5, sgst: 47.5, total: 1995 });
    });

    it('a walk-in, part-paid bill with round-off and no GST', async () => {
        const { service } = build({
            ...baseOrder,
            totalPrice: d('1049.60'),
            metadata: { pos: { storeId: 'default', roundOff: 0.4, clientSaleId: 'c2' } },
            dispatchWarehouse: null,
            posStaff: null,
            customer: null,
            payments: [{ method: 'CASH', amount: d('500'), tendered: null, reference: null }],
            lineItems: [line({ quantity: 1, price: d('1049.60'), totalDiscount: d('0'), channelTaxLines: [], channelTaxAmount: d('0'), variant: null })],
            invoices: [],
        });
        const r = await service.receipt(ORG, 'order_1');
        expect(r.customer).toBeNull();
        expect(r.order).toMatchObject({ staffName: null, storeName: 'Acme Store' });
        expect(r.lines[0]).toMatchObject({ hsn: null, gstRate: null, taxableValue: 1049.6, total: 1049.6 });
        expect(r.gstSummary).toEqual([]);
        expect(r.totals).toMatchObject({ roundOff: 0.4, total: 1049.6, payable: 1050 });
        expect(r.paid).toBe(500);
        expect(r.balanceDue).toBe(550);
    });

    it('prices that include GST: the taxable value is what was charged less the tax in it', async () => {
        const { service } = build({ ...baseOrder, taxesIncluded: true, totalPrice: d('1900'), lineItems: [line({ channelTaxAmount: d('90.48') })], invoices: [] });
        const r = await service.receipt(ORG, 'order_1');
        expect(r.lines[0]).toMatchObject({ taxableValue: 1809.52, total: 1900 });
    });

    it('a bill of another org is not found', async () => {
        const { service } = build(null);
        await expect(service.receipt(ORG, 'order_x')).rejects.toBeInstanceOf(NotFoundException);
    });
});
