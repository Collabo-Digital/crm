import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvoiceSettingsSchema } from '../../organization-settings/schemas/invoice-settings.schema';
import type { PrismaService } from '../../prisma/prisma.service';
import { imageOf, loadBillContext, loadDocImage, loadInvoiceDocument, loadPreviewContext } from './build-loader';

/**
 * The loaders' side of the builders: pictures from the image storage by
 * their first bytes, and the rows a document reads turned into plain values.
 * The queries themselves were run against Postgres; the storage keeps its
 * reads inside the uploads folder (local.storage.spec.ts).
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest of a jpeg')]);
const GIF = Buffer.from('GIF89a and the rest');

/** An image storage holding these files; any other key is not found, as the real one says. */
function storageWith(files: Record<string, Buffer> = {}) {
    return {
        read: jest.fn((key: string) => (files[key] ? Promise.resolve(files[key]) : Promise.reject(new NotFoundException('Image not found')))),
    };
}

describe('pictures on documents', () => {
    const storage = storageWith({ 'org_1/logo.png': PNG, 'org_1/sign.jpg': JPEG, 'org_1/renamed.png': GIF });

    it('knows PNG and JPEG by their first bytes, and nothing else', () => {
        expect(imageOf(PNG)).toEqual({ data: PNG, format: 'png' });
        expect(imageOf(JPEG)).toEqual({ data: JPEG, format: 'jpg' });
        expect(imageOf(GIF)).toBeNull();
        expect(imageOf(Buffer.alloc(0))).toBeNull();
    });

    it('reads an upload from the image storage by its key', async () => {
        await expect(loadDocImage(storage, 'org_1/logo.png')).resolves.toEqual({ data: PNG, format: 'png' });
        await expect(loadDocImage(storage, 'org_1/sign.jpg')).resolves.toEqual({ data: JPEG, format: 'jpg' });
        expect(storage.read).toHaveBeenCalledWith('org_1/logo.png');
    });

    it('prints without the picture when there is none, it is gone, or it is not an image', async () => {
        storage.read.mockClear();
        await expect(loadDocImage(storage, null)).resolves.toBeNull();
        expect(storage.read).not.toHaveBeenCalled();
        await expect(loadDocImage(storage, 'org_1/missing.png')).resolves.toBeNull();
        await expect(loadDocImage(storage, 'org_1/renamed.png')).resolves.toBeNull();
    });
});

const d = (v: string | number) => new Prisma.Decimal(v);
const SNAPSHOT = {
    v: 1,
    documentType: 'BILL_OF_SUPPLY',
    composition: true,
    eInvoiceDeclaration: false,
    design: InvoiceSettingsSchema.parse({ theme: 'classic' }),
    brand: { tradeName: 'Saanjh then', logoStorageKey: null, supportPhone: '', whatsappPhone: '', supportEmail: '', website: '', upiId: null },
};

function prismaWith(invoice: Record<string, unknown> | null, settings: Record<string, unknown> | null = null) {
    const mocks = {
        invoice: { findFirst: jest.fn().mockResolvedValue(invoice) },
        organization: {
            findUnique: jest.fn().mockResolvedValue({ name: 'Saanjh', website: 'https://saanjh.example', timezone: 'UTC', currency: 'inr', gstEnabled: true }),
        },
        organizationSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
        organizationGstin: { findFirst: jest.fn().mockResolvedValue({ gstin: '29ABCDE1234F1Z5', legalName: 'Saanjh Apparel Private Limited', address: null, stateCode: '29', stateName: 'Karnataka' }) },
    };
    return { mocks, prisma: mocks as unknown as PrismaService };
}

const ROW = {
    invoiceNumber: 'INV-26-27/000124', invoiceDate: new Date('2026-10-26T20:00:00Z'), status: 'ISSUED', cancelledAt: null, currency: 'INR', gstType: 'IGST',
    reverseCharge: false, sellerLegalName: 'Saanjh Apparel Private Limited', sellerGstin: '29ABCDE1234F1Z5', sellerAddress: null, sellerStateCode: '29',
    sellerStateName: 'Karnataka', dispatchName: null, dispatchAddress: null, buyerName: 'Asha Menon', buyerGstin: null, buyerAddress: null,
    buyerStateCode: '32', buyerStateName: 'Kerala', placeOfSupply: '32', placeOfSupplyName: 'Kerala', subtotal: d('1237.14'), totalCgst: d('0'),
    totalSgst: d('0'), totalIgst: d('61.86'), shippingCharge: d('0'), grandTotal: d('1299.00'), notes: null, creditNoteReason: null, metadata: null,
    creditNoteFor: null,
    lineItems: [{
        orderLineItemId: 'oli_2', description: 'Linen Palazzo Pants - Beige / M', hsnCode: '6204', unitOfMeasure: 'PCS', quantity: 1, unitPrice: d('1237.14'),
        discount: d('0'), taxableValue: d('1237.14'), gstRate: d('5.00'), cgstRate: d('0'), cgstAmount: d('0'), sgstRate: d('0'), sgstAmount: d('0'),
        igstRate: d('5.00'), igstAmount: d('61.86'), totalAmount: d('1299.00'),
    }],
    order: {
        name: '#1042', createdAt: new Date('2026-10-25T13:30:00Z'), externalCreatedAt: new Date('2026-10-25T13:00:00Z'), financialStatus: 'PAID',
        paymentGateways: ['razorpay'], posSale: false, metadata: { paymentMethod: 'UPI', pos: { roundOff: 0 } }, shippingAddress: null,
        customer: { phone: '+919847012345', email: null },
        lineItems: [{ id: 'oli_2', title: 'Linen Palazzo Pants', variantTitle: 'Beige / M', sku: 'SJ-PLZ-BEI-M' }],
        fulfillments: [{ trackingCompany: 'Delhivery', trackingNumber: '1490000000000' }],
        payments: [{ method: 'UPI', amount: d('1299.00'), reference: 'UTR42', createdAt: new Date('2026-10-25T13:05:00Z') }],
        paymentLinks: [{ provider: 'RAZORPAY', paymentMethod: 'upi', paymentId: 'pay_1', amountPaid: d('1299.00'), paidAt: new Date('2026-10-25T13:10:00Z') }],
        timeline: [{ createdAt: new Date('2026-10-25T13:11:00Z') }],
    },
};

describe('loadInvoiceDocument', () => {
    it('hands the builder plain numbers, the order as it is now, and the time zone (India for an untouched UTC)', async () => {
        const input = await loadInvoiceDocument(prismaWith(ROW, { taxSettings: { defaultUnitOfMeasure: 'PCS' } }).prisma, storageWith(), 'org_1', 'inv_1');
        expect(input.invoice).toMatchObject({ subtotal: 1237.14, totalIgst: 61.86, grandTotal: 1299 });
        expect(input.invoice.lineItems[0]).toMatchObject({ unitPrice: 1237.14, gstRate: 5, igstRate: 5, igstAmount: 61.86, totalAmount: 1299 });
        expect(input.order).toEqual({
            name: '#1042',
            placedAt: new Date('2026-10-25T13:00:00Z'),
            financialStatus: 'PAID',
            paymentGateways: ['razorpay'],
            paymentMethod: 'UPI',
            posSale: false,
            shippingAddress: null,
            customer: { phone: '+919847012345', email: null },
            lineItems: [{ id: 'oli_2', title: 'Linen Palazzo Pants', variantTitle: 'Beige / M', sku: 'SJ-PLZ-BEI-M' }],
            tracking: { company: 'Delhivery', number: '1490000000000' },
            payments: [{ method: 'UPI', amount: 1299, reference: 'UTR42', createdAt: new Date('2026-10-25T13:05:00Z') }],
            paymentLink: { provider: 'RAZORPAY', paymentMethod: 'upi', paymentId: 'pay_1', amountPaid: 1299, paidAt: new Date('2026-10-25T13:10:00Z') },
            paidEventAt: new Date('2026-10-25T13:11:00Z'),
        });
        expect(input).toMatchObject({ timeZone: 'Asia/Kolkata', defaultUnit: 'PCS', original: null, logo: null, signature: null });
    });

    it('prints from the snapshot the invoice was issued with, its logo and signature from the image storage', async () => {
        const snapshot = {
            ...SNAPSHOT,
            design: InvoiceSettingsSchema.parse({ theme: 'classic', signature: { storageKey: 'org_1/sign.jpg', url: 'u' } }),
            brand: { ...SNAPSHOT.brand, logoStorageKey: 'org_1/logo.png' },
        };
        const storage = storageWith({ 'org_1/logo.png': PNG, 'org_1/sign.jpg': JPEG });
        const input = await loadInvoiceDocument(prismaWith({ ...ROW, metadata: { render: snapshot } }).prisma, storage, 'org_1', 'inv_1');
        expect(input.snapshot).toEqual(snapshot);
        expect(input).toMatchObject({ logo: { data: PNG, format: 'png' }, signature: { data: JPEG, format: 'jpg' } });
    });

    it('one issued before snapshots: the current settings, store profile and UPI id, as a tax invoice', async () => {
        const settings = {
            invoiceSettings: { theme: 'classic', brandColor: '#0F766E' },
            storeProfileSettings: { storeName: 'Saanjh Studio', supportEmail: 'care@saanjh.example' },
            posSettings: { upiId: 'saanjh@okaxis' },
            taxSettings: null,
        };
        const input = await loadInvoiceDocument(prismaWith(ROW, settings).prisma, storageWith(), 'org_1', 'inv_1');
        expect(input.snapshot).toMatchObject({
            documentType: 'TAX_INVOICE',
            composition: false,
            eInvoiceDeclaration: false,
            design: { theme: 'classic', brandColor: '#0F766E' },
            brand: { tradeName: 'Saanjh Studio', supportEmail: 'care@saanjh.example', website: 'https://saanjh.example', upiId: 'saanjh@okaxis', logoStorageKey: null },
        });
        expect(input.defaultUnit).toBe('NOS');
    });

    it('scoped to the organization, and a 404 for any other', async () => {
        const { prisma, mocks } = prismaWith(null);
        await expect(loadInvoiceDocument(prisma, storageWith(), 'org_1', 'inv_x')).rejects.toBeInstanceOf(NotFoundException);
        expect(mocks.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'inv_x', organizationId: 'org_1' } }));
    });

    it('reads only the first paid payment link, the latest tracked fulfillment and the latest "paid" entry', async () => {
        const { prisma, mocks } = prismaWith(ROW);
        await loadInvoiceDocument(prisma, storageWith(), 'org_1', 'inv_1');
        const [query] = mocks.invoice.findFirst.mock.calls[0] as [{ include: { order: { select: Record<string, unknown> } } }];
        const order = query.include.order.select;
        expect(order.paymentLinks).toMatchObject({ where: { status: 'PAID' }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }], take: 1 });
        expect(order.fulfillments).toMatchObject({ orderBy: { createdAt: 'desc' }, take: 1 });
        expect(order.timeline).toMatchObject({ where: { action: 'paid' }, orderBy: { createdAt: 'desc' }, take: 1 });
    });
});

describe('loadBillContext and loadPreviewContext', () => {
    it('a bill: the current settings, in the currency the till sells in', async () => {
        const settings = { invoiceSettings: { footerNote: 'Visit again!' }, storeProfileSettings: { logoStorageKey: 'org_1/logo.png' } };
        const context = await loadBillContext(prismaWith(null, settings).prisma, storageWith({ 'org_1/logo.png': PNG }), 'org_1');
        expect(context).toMatchObject({
            currency: 'INR',
            timeZone: 'Asia/Kolkata',
            logo: { data: PNG, format: 'png' },
            design: { footerNote: 'Visit again!' },
            brand: { tradeName: 'Saanjh' },
        });
    });

    it('a preview: the edits over the saved settings, the uploaded signature kept, and the real registration with GST on', async () => {
        const { prisma, mocks } = prismaWith(null, { invoiceSettings: { theme: 'classic', terms: 'Saved terms', signature: { storageKey: 'org_1/missing.png', url: 'u' } } });
        const context = await loadPreviewContext(prisma, storageWith(), 'org_1', { theme: 'modern', brandColor: '#0F766E' });
        expect(context.design).toMatchObject({ theme: 'modern', brandColor: '#0F766E', terms: 'Saved terms', signature: { storageKey: 'org_1/missing.png' } });
        expect(context.registration).toMatchObject({ gstin: '29ABCDE1234F1Z5', legalName: 'Saanjh Apparel Private Limited' });
        expect(context.signature).toBeNull();
        expect(mocks.organizationGstin.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { organizationId: 'org_1', isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
        );
    });

    it('a preview without GST has no registration to print', async () => {
        const { prisma, mocks } = prismaWith(null);
        mocks.organization.findUnique.mockResolvedValue({ name: 'Saanjh', website: null, timezone: 'UTC', currency: 'INR', gstEnabled: false });
        expect((await loadPreviewContext(prisma, storageWith(), 'org_1')).registration).toBeNull();
    });
});
