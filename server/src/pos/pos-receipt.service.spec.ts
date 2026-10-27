import { NotFoundException } from '@nestjs/common';
import { GstType, Prisma } from '@prisma/client';
import { InvoiceSettingsSchema } from '../organization-settings/schemas/invoice-settings.schema';
import type { PrismaService } from '../prisma/prisma.service';
import { billLinkKey, billToken } from './pos-bill-link';
import { PosReceiptService } from './pos-receipt.service';
import { parsePosSettings } from './pos-settings.schema';

/**
 * The receipt's tax figures come from the GST invoice when one was issued,
 * and from what each line was charged otherwise; either way the shape is the
 * same, so a till prints both without knowing which it has. Around them, the
 * invoice settings decide the IDs, the customer's number, the QR and the
 * return line, and the invoice decides which document it is.
 */

const d = (v: string | number) => new Prisma.Decimal(v);
const ORG = 'org_1';
const SECRET = 'e'.repeat(32);

const PROFILE = {
    storeName: 'Acme Store', address1: '12 MG Road', address2: '', city: 'Bengaluru', province: 'Karnataka', zip: '560001',
    country: 'India', supportPhone: '+91 80 4000 0000', whatsappPhone: '+91 90000 00000', supportEmail: '', website: '', logoUrl: '',
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

function build(order: Record<string, unknown> | null, opts: { invoiceSettings?: unknown; pos?: Record<string, unknown> } = {}) {
    const prisma = {
        order: { findFirst: jest.fn().mockResolvedValue(order) },
        organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme Pvt Ltd', logo: 'https://cdn/logo.png', gstEnabled: true }) },
        organizationGstin: {
            findFirst: jest.fn().mockResolvedValue({ gstin: '29AAACA1234A1Z5', legalName: 'Acme Retail Private Limited', address: { address1: 'Reg office' } }),
        },
        organizationSettings: { findUnique: jest.fn().mockResolvedValue({ invoiceSettings: opts.invoiceSettings ?? null }) },
        $executeRaw: jest.fn(),
    };
    const config = { get: (k: string) => ({ encryptionKey: SECRET, frontendUrl: 'https://app.example.com/' })[k] };
    const service = new PosReceiptService(
        prisma as unknown as PrismaService,
        { getStoreProfileSettings: jest.fn().mockResolvedValue(PROFILE) } as any,
        { settings: jest.fn().mockResolvedValue(parsePosSettings({ receiptWidth: 58, receiptFooter: 'No exchange after 7 days.', ...opts.pos })) } as any,
        config as any,
    );
    return { service, prisma };
}

const baseOrder = {
    id: 'order_1', name: '#M1001', createdAt: new Date('2026-10-26T06:30:00Z'), totalPrice: d('1995.00'), taxesIncluded: false, posSale: true,
    metadata: { source: 'offline', pos: { storeId: 'wh_1', roundOff: 0, clientSaleId: 'c1' } },
    posStaff: { name: 'Ravi' },
    dispatchWarehouse: { name: 'MG Road' },
    customer: { firstName: 'Asha', lastName: 'Menon', phone: '+919800000001', gstin: null },
    payments: [
        { method: 'CASH', amount: d('1000'), tendered: d('2000'), reference: null, createdAt: new Date('2026-10-26T06:31:00Z') },
        { method: 'UPI', amount: d('995'), tendered: null, reference: 'UTR42', createdAt: new Date('2026-10-26T06:32:00Z') },
    ],
};

const invoiceOf = (over: Record<string, unknown> = {}) => ({
    invoiceNumber: 'INV-26-27/000007', invoiceDate: new Date('2026-10-26T00:00:00Z'), placeOfSupply: '29', placeOfSupplyName: 'Karnataka',
    gstType: GstType.CGST_SGST, sellerGstin: '29AAACA9999A1Z5', sellerLegalName: 'Acme Retail Private Limited', sellerAddress: null, metadata: null,
    lineItems: [{
        orderLineItemId: 'li_1', hsnCode: '6205', taxableValue: d('1900'), gstRate: d('5'),
        cgstAmount: d('47.50'), sgstAmount: d('47.50'), igstAmount: d('0'), totalAmount: d('1995'),
    }],
    ...over,
});

const EBILL = `https://app.example.com/b/${billToken(billLinkKey(SECRET), 'order_1')}`;

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
            legalName: 'Acme Retail Private Limited',
            whatsapp: '+91 90000 00000',
            ids: [{ label: 'PAN', value: 'AAACA1234A' }],
        });
        expect(r.document).toEqual({ title: 'BILL', subtitle: null });
        expect(r.order).toEqual({ id: 'order_1', name: '#M1001', createdAt: '2026-10-26T06:30:00.000Z', staffName: 'Ravi', storeName: 'MG Road' });
        expect(r.invoice).toBeNull();
        expect(r.customer).toEqual({ name: 'Asha Menon', phone: '+919800000001', gstin: null, phoneShown: '+91 98••• ••001' });
        expect(r.lines).toEqual([
            {
                title: 'Linen shirt', variantTitle: 'M', hsn: '6205', quantity: 2, unitPrice: 1000, discount: 100,
                taxableValue: 1900, gstRate: 5, cgst: 47.5, sgst: 47.5, igst: 0, total: 1995, taxCode: 'A',
            },
        ]);
        expect(r.totals).toEqual({ subtotal: 2000, discount: 100, taxable: 1900, cgst: 47.5, sgst: 47.5, igst: 0, roundOff: 0, total: 1995, payable: 1995 });
        expect(r.gstSummary).toEqual([{ rate: 5, taxable: 1900, cgst: 47.5, sgst: 47.5, igst: 0, code: 'A' }]);
        expect(r.payments).toEqual([
            { method: 'CASH', amount: 1000, tendered: 2000, change: 1000, reference: null, at: '2026-10-26T06:31:00.000Z' },
            { method: 'UPI', amount: 995, tendered: null, change: null, reference: 'UTR42', at: '2026-10-26T06:32:00.000Z' },
        ]);
        expect(r.paid).toBe(1995);
        expect(r.balanceDue).toBe(0);
        expect(r.returnPolicy).toBeNull();
        expect(r.qr).toEqual({ kind: 'ebill', url: EBILL });
        expect(r.printedBefore).toBe(false);
    });

    it("with an invoice: the invoice's figures, number, place of supply, tax type and seller", async () => {
        const { service } = build({ ...baseOrder, lineItems: [line({ channelTaxLines: null, channelTaxAmount: null })], invoices: [invoiceOf()] });
        const r = await service.receipt(ORG, 'order_1');
        expect(r.invoice).toEqual({ number: 'INV-26-27/000007', date: '2026-10-26T00:00:00.000Z', placeOfSupply: 'Karnataka', gstType: 'INTRA' });
        expect(r.store.gstin).toBe('29AAACA9999A1Z5');
        expect(r.store.ids).toEqual([{ label: 'PAN', value: 'AAACA9999A' }]);
        expect(r.lines[0]).toMatchObject({ hsn: '6205', taxableValue: 1900, gstRate: 5, cgst: 47.5, sgst: 47.5, total: 1995, taxCode: 'A' });
    });

    it('is a tax invoice, or a bill of supply with the composition line, as its invoice was issued', async () => {
        const snapshot = (documentType: string, composition: boolean) => ({
            render: {
                v: 1, documentType, composition, eInvoiceDeclaration: false, design: InvoiceSettingsSchema.parse({}),
                brand: { tradeName: 'Acme', logoStorageKey: null, supportPhone: '', whatsappPhone: '', supportEmail: '', website: '', upiId: null },
            },
        });
        const of = async (metadata: unknown) =>
            (await build({ ...baseOrder, lineItems: [line()], invoices: [invoiceOf({ metadata })] }).service.receipt(ORG, 'order_1')).document;
        expect(await of(null)).toEqual({ title: 'TAX INVOICE', subtitle: null });
        expect(await of(snapshot('TAX_INVOICE', false))).toEqual({ title: 'TAX INVOICE', subtitle: null });
        expect(await of(snapshot('BILL_OF_SUPPLY', true))).toEqual({
            title: 'BILL OF SUPPLY',
            subtitle: 'Composition taxable person, not eligible to collect tax on supplies',
        });
        expect(await of(snapshot('BILL_OF_SUPPLY', false))).toEqual({ title: 'BILL OF SUPPLY', subtitle: null });
    });

    it('gives each rate a letter, A for the lowest, on the lines and the GST summary', async () => {
        const kurta = line({
            id: 'li_2', title: 'Silk kurta', quantity: 1, price: d('3000'), totalDiscount: d('0'), channelTaxAmount: d('540'),
            channelTaxLines: [{ title: 'CGST', rate: 0.09, price: '270' }, { title: 'SGST', rate: 0.09, price: '270' }],
        });
        const walkIn = line({ id: 'li_3', title: 'Gift wrap', quantity: 1, price: d('50'), totalDiscount: d('0'), channelTaxLines: [], channelTaxAmount: null });
        const { service } = build({ ...baseOrder, totalPrice: d('5585'), lineItems: [kurta, line(), walkIn], invoices: [] });
        const r = await service.receipt(ORG, 'order_1');
        expect(r.lines.map((l) => [l.title, l.gstRate, l.taxCode])).toEqual([
            ['Silk kurta', 18, 'B'],
            ['Linen shirt', 5, 'A'],
            ['Gift wrap', null, null],
        ]);
        expect(r.gstSummary.map((g) => [g.code, g.rate])).toEqual([['A', 5], ['B', 18]]);
    });

    it('PAN and the IDs meant for receipts, the return policy and its link', async () => {
        const { service } = build(
            { ...baseOrder, lineItems: [line()], invoices: [] },
            {
                invoiceSettings: {
                    businessIds: [
                        { type: 'FSSAI', value: '11223344556677', onReceipt: true },
                        { type: 'CIN', value: 'U18101KA2021PTC000000', onReceipt: false },
                        { type: 'CUSTOM', label: 'Shop Reg.', value: 'BLR-42', onReceipt: true },
                    ],
                    returnPolicy: 'Exchange within 7 days with this bill.',
                    returnPolicyUrl: 'https://acme.example/returns',
                },
            },
        );
        const r = await service.receipt(ORG, 'order_1');
        expect(r.store.ids).toEqual([
            { label: 'PAN', value: 'AAACA1234A' },
            { label: 'FSSAI Lic. No.', value: '11223344556677' },
            { label: 'Shop Reg.', value: 'BLR-42' },
        ]);
        expect(r.returnPolicy).toBe('Exchange within 7 days with this bill. https://acme.example/returns');
    });

    it.each([
        ['hide', null],
        ['mask', '+91 98••• ••001'],
        ['show', '+919800000001'],
    ])('the customer’s number on the receipt: %s', async (receiptCustomerContact, shown) => {
        const { service } = build({ ...baseOrder, lineItems: [line()], invoices: [] }, { invoiceSettings: { receiptCustomerContact } });
        const r = await service.receipt(ORG, 'order_1');
        expect(r.customer).toMatchObject({ phone: '+919800000001', phoneShown: shown });
    });

    it('no legal name when it is the store’s own name, and none without GST', async () => {
        const same = build({ ...baseOrder, lineItems: [line()], invoices: [] });
        same.prisma.organizationGstin.findFirst.mockResolvedValue({ gstin: '29AAACA1234A1Z5', legalName: 'ACME STORE', address: null });
        expect((await same.service.receipt(ORG, 'order_1')).store.legalName).toBeNull();

        const noGst = build({ ...baseOrder, lineItems: [line()], invoices: [] });
        noGst.prisma.organization.findUnique.mockResolvedValue({ name: 'Acme Pvt Ltd', logo: null, gstEnabled: false });
        const r = await noGst.service.receipt(ORG, 'order_1');
        expect(r.store).toMatchObject({ gstin: null, legalName: null, ids: [] });
    });

    describe('the QR', () => {
        const due = { ...baseOrder, payments: [{ method: 'CASH', amount: d('500'), tendered: null, reference: null, createdAt: new Date() }], lineItems: [line()], invoices: [] };

        it('links to the e-bill by default, and to nothing when switched off', async () => {
            expect((await build(due).service.receipt(ORG, 'order_1')).qr).toEqual({ kind: 'ebill', url: EBILL });
            expect((await build(due, { invoiceSettings: { receiptQr: 'off' } }).service.receipt(ORG, 'order_1')).qr).toBeNull();
        });

        it('asks for the balance by UPI while one is due and the store has a UPI id', async () => {
            const r = await build(due, { invoiceSettings: { receiptQr: 'upi-when-due' }, pos: { upiId: 'acme@okaxis', upiPayeeName: 'Acme Retail' } }).service.receipt(ORG, 'order_1');
            expect(r.balanceDue).toBe(1495);
            expect(r.qr).toEqual({ kind: 'upi', uri: 'upi://pay?pa=acme@okaxis&pn=Acme%20Retail&am=1495.00&cu=INR&tn=%23M1001', amount: 1495 });
        });

        it('falls back to the e-bill when nothing is due or there is no UPI id', async () => {
            const paid = { ...baseOrder, lineItems: [line()], invoices: [] };
            expect((await build(paid, { invoiceSettings: { receiptQr: 'upi-when-due' }, pos: { upiId: 'acme@okaxis' } }).service.receipt(ORG, 'order_1')).qr).toEqual({ kind: 'ebill', url: EBILL });
            expect((await build(due, { invoiceSettings: { receiptQr: 'upi-when-due' } }).service.receipt(ORG, 'order_1')).qr).toEqual({ kind: 'ebill', url: EBILL });
        });

        it('has no e-bill for an order that is not a till sale: the link opens only those', async () => {
            expect((await build({ ...baseOrder, posSale: false, lineItems: [line()], invoices: [] }).service.receipt(ORG, 'order_1')).qr).toBeNull();
        });
    });

    it('says when it has been printed before', async () => {
        const { service } = build({ ...baseOrder, metadata: { pos: { storeId: 'wh_1', roundOff: 0, clientSaleId: 'c1', printedAt: '2026-10-26T06:35:00.000Z' } }, lineItems: [line()], invoices: [] });
        expect((await service.receipt(ORG, 'order_1')).printedBefore).toBe(true);
    });

    it('a walk-in, part-paid bill with round-off and no GST', async () => {
        const { service } = build({
            ...baseOrder,
            totalPrice: d('1049.60'),
            metadata: { pos: { storeId: 'default', roundOff: 0.4, clientSaleId: 'c2' } },
            dispatchWarehouse: null,
            posStaff: null,
            customer: null,
            payments: [{ method: 'CASH', amount: d('500'), tendered: null, reference: null, createdAt: new Date() }],
            lineItems: [line({ quantity: 1, price: d('1049.60'), totalDiscount: d('0'), channelTaxLines: [], channelTaxAmount: d('0'), variant: null })],
            invoices: [],
        });
        const r = await service.receipt(ORG, 'order_1');
        expect(r.customer).toBeNull();
        expect(r.order).toMatchObject({ staffName: null, storeName: 'Acme Store' });
        expect(r.lines[0]).toMatchObject({ hsn: null, gstRate: null, taxableValue: 1049.6, total: 1049.6, taxCode: null });
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

describe('PosReceiptService.markPrinted', () => {
    it('the first print is recorded on the order, and was not printed before', async () => {
        const { service, prisma } = build(null);
        prisma.$executeRaw.mockResolvedValue(1);
        await expect(service.markPrinted(ORG, 'order_1')).resolves.toEqual({ printedBefore: false });
        const [sql, printedAt, ...where] = prisma.$executeRaw.mock.calls[0] as [TemplateStringsArray, string, ...string[]];
        expect(sql.join('?')).toContain(`'{pos}'`);
        expect(sql.join('?')).toContain(`"metadata"->'pos'->>'printedAt' IS NULL`);
        expect(printedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(where).toEqual(['order_1', ORG]);
        expect(prisma.order.findFirst).not.toHaveBeenCalled();
    });

    it('a later print was printed before, and leaves the first time as it was', async () => {
        const { service, prisma } = build({ id: 'order_1' });
        prisma.$executeRaw.mockResolvedValue(0);
        await expect(service.markPrinted(ORG, 'order_1')).resolves.toEqual({ printedBefore: true });
        expect(prisma.order.findFirst).toHaveBeenCalledWith({ where: { id: 'order_1', organizationId: ORG, deletedAt: null }, select: { id: true } });
    });

    it('a bill of another org is not found', async () => {
        const { service, prisma } = build(null);
        prisma.$executeRaw.mockResolvedValue(0);
        await expect(service.markPrinted(ORG, 'order_x')).rejects.toThrow(new NotFoundException('That bill was not found.'));
    });
});
