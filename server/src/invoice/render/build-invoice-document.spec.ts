import { InvoiceSettingsSchema, type InvoiceSettings } from '../../organization-settings/schemas/invoice-settings.schema';
import { buildInvoiceDocument, invoicePdfFilename, type InvoiceDocumentInput } from './build-invoice-document';
import { currentSnapshot } from './build-parts';
import type { DocImage } from './document-model';

/**
 * Every rule of design section 4.3 for invoices, credit notes and cancelled
 * invoices, on plain objects. The base is the research mock-up's Modern B2C
 * invoice: a Karnataka seller, a Kerala buyer, three lines at two rates, paid
 * by UPI through a Razorpay link.
 */

const LOGO: DocImage = { data: Buffer.from('logo'), format: 'png' };
const SIGNATURE: DocImage = { data: Buffer.from('sign'), format: 'jpg' };
const BRAND = {
    tradeName: 'Saanjh',
    logoStorageKey: 'org_1/logo.png',
    supportPhone: '+91 80 4000 0000',
    whatsappPhone: '+91 90000 00000',
    supportEmail: 'care@saanjh.example',
    website: 'https://saanjh.example/',
    upiId: 'saanjh@okaxis',
};
const design = (over: Record<string, unknown> = {}): InvoiceSettings => InvoiceSettingsSchema.parse(over);

const line = (over: Record<string, unknown>) => ({
    orderLineItemId: null,
    description: '',
    hsnCode: null,
    unitOfMeasure: 'PCS',
    quantity: 1,
    unitPrice: 0,
    discount: 0,
    taxableValue: 0,
    gstRate: 0,
    cgstRate: 0,
    cgstAmount: 0,
    sgstRate: 0,
    sgstAmount: 0,
    igstRate: 0,
    igstAmount: 0,
    totalAmount: 0,
    ...over,
});

function base(): InvoiceDocumentInput {
    return {
        invoice: {
            invoiceNumber: 'INV-26-27/000124',
            // 01:30 on 27 Oct in India: the date prints in the organization's time zone.
            invoiceDate: new Date('2026-10-26T20:00:00Z'),
            status: 'ISSUED',
            cancelledAt: null,
            currency: 'INR',
            gstType: 'IGST',
            reverseCharge: false,
            sellerLegalName: 'Saanjh Apparel Private Limited',
            sellerGstin: '29ABCDE1234F1Z5',
            sellerAddress: { address1: 'No. 12, 100 Feet Road', address2: 'Indiranagar', city: 'Bengaluru', zip: '560038', province: 'Karnataka' },
            sellerStateCode: '29',
            sellerStateName: 'Karnataka',
            dispatchName: null,
            dispatchAddress: null,
            buyerName: 'Asha Menon',
            buyerGstin: null,
            buyerAddress: { address1: 'Flat 4B, Palm Grove Apartments', address2: 'Kadavanthra', city: 'Kochi', zip: '682020', province: 'Kerala' },
            buyerStateCode: '32',
            buyerStateName: 'Kerala',
            placeOfSupply: '32',
            placeOfSupplyName: 'Kerala',
            subtotal: 5063.43,
            totalCgst: 0,
            totalSgst: 0,
            totalIgst: 583.57,
            shippingCharge: 0,
            grandTotal: 5647,
            notes: null,
            creditNoteReason: null,
            lineItems: [
                line({
                    orderLineItemId: 'oli_1', description: 'Handblock Cotton Kurta - Indigo / M', hsnCode: '6211', unitPrice: 1427.62, discount: 142.86,
                    taxableValue: 1284.76, gstRate: 5, igstRate: 5, igstAmount: 64.24, totalAmount: 1349,
                }),
                line({
                    orderLineItemId: 'oli_2', description: 'Linen Palazzo Pants - Beige / M', hsnCode: '6204', unitPrice: 1237.14,
                    taxableValue: 1237.14, gstRate: 5, igstRate: 5, igstAmount: 61.86, totalAmount: 1299,
                }),
                line({
                    orderLineItemId: 'oli_3', description: 'Pure Silk Dupatta - Rust', hsnCode: '6214', unitPrice: 2541.53,
                    taxableValue: 2541.53, gstRate: 18, igstRate: 18, igstAmount: 457.47, totalAmount: 2999,
                }),
            ],
        },
        original: null,
        order: {
            name: '#1042',
            placedAt: new Date('2026-10-25T13:00:00Z'),
            financialStatus: 'PAID',
            paymentGateways: ['razorpay'],
            paymentMethod: null,
            posSale: false,
            shippingAddress: { address1: 'Flat 4B, Palm Grove Apartments', address2: 'Kadavanthra', city: 'Kochi', zip: '682020', province: 'Kerala', phone: '+919847012345' },
            customer: { phone: '+919847012345', email: 'asha.menon@gmail.com' },
            lineItems: [
                { id: 'oli_1', title: 'Handblock Cotton Kurta', variantTitle: 'Indigo / M', sku: 'SJ-KUR-IND-M' },
                { id: 'oli_2', title: 'Linen Palazzo Pants', variantTitle: 'Beige / M', sku: 'SJ-PLZ-BEI-M' },
                { id: 'oli_3', title: 'Pure Silk Dupatta', variantTitle: 'Rust', sku: 'SJ-DUP-RST' },
            ],
            tracking: { company: 'Delhivery', number: '1490000000000' },
            payments: [],
            paymentLink: { provider: 'RAZORPAY', paymentMethod: 'upi', paymentId: 'pay_SAMPLE7Hx2', amountPaid: 5647, paidAt: new Date('2026-10-25T13:12:00Z') },
            paidEventAt: new Date('2026-10-25T13:13:00Z'),
        },
        snapshot: { v: 1, documentType: 'TAX_INVOICE', composition: false, eInvoiceDeclaration: false, design: design(), brand: { ...BRAND } },
        logo: LOGO,
        signature: null,
        timeZone: 'Asia/Kolkata',
        defaultUnit: 'NOS',
    };
}

/** An unpaid sale: no payment link, nothing received. */
function unpaid(): InvoiceDocumentInput {
    const i = base();
    i.order.financialStatus = 'PENDING';
    i.order.paymentLink = null;
    i.order.paidEventAt = null;
    return i;
}

/** A partial credit note against the base invoice, as Collabo raises one: lines scaled, no quantity. */
function creditNote(): InvoiceDocumentInput {
    const i = base();
    i.invoice = {
        ...i.invoice,
        invoiceNumber: 'CN-26-27/000009',
        invoiceDate: new Date('2026-10-28T06:00:00Z'),
        status: 'CREDIT_NOTE',
        subtotal: 1349.56,
        totalIgst: 150.44,
        grandTotal: 1500,
        creditNoteReason: 'Returned: Pure Silk Dupatta',
        lineItems: [
            line({ orderLineItemId: 'oli_1', hsnCode: '6211', quantity: 0, unitPrice: 1427.62, discount: 37.95, taxableValue: 341.27, gstRate: 5, igstRate: 5, igstAmount: 17.06, totalAmount: 358.33 }),
            line({ orderLineItemId: 'oli_2', hsnCode: '6204', quantity: 0, unitPrice: 1237.14, taxableValue: 328.62, gstRate: 5, igstRate: 5, igstAmount: 16.43, totalAmount: 345.05 }),
            line({ orderLineItemId: 'oli_3', hsnCode: '6214', quantity: 0, unitPrice: 2541.53, taxableValue: 679.67, gstRate: 18, igstRate: 18, igstAmount: 116.95, totalAmount: 796.62 }),
        ],
    };
    i.original = { invoiceNumber: 'INV-26-27/000124', invoiceDate: new Date('2026-10-26T20:00:00Z') };
    return i;
}

/** An intra-state business invoice: CGST and SGST, a GSTIN, eight units of one line. */
function business(): InvoiceDocumentInput {
    const i = unpaid();
    i.invoice = {
        ...i.invoice,
        gstType: 'CGST_SGST',
        buyerName: 'Kavya Retail LLP',
        buyerGstin: '29AAAFK0000A1Z5',
        buyerAddress: { address1: '45, Commercial Street', city: 'Bengaluru', zip: '560001', province: 'Karnataka' },
        buyerStateCode: '29',
        buyerStateName: 'Karnataka',
        placeOfSupply: '29',
        placeOfSupplyName: 'Karnataka',
        subtotal: 2820,
        totalCgst: 70.5,
        totalSgst: 70.5,
        totalIgst: 0,
        grandTotal: 2961,
        lineItems: [
            line({
                orderLineItemId: 'oli_1', hsnCode: '6211', quantity: 6, unitPrice: 520, discount: 300, taxableValue: 2820, gstRate: 5,
                cgstRate: 2.5, cgstAmount: 70.5, sgstRate: 2.5, sgstAmount: 70.5, totalAmount: 2961,
            }),
        ],
    };
    i.order.shippingAddress = { name: 'Kavya Retail LLP (Whitefield store)', address1: 'Unit 12, Phoenix Marketcity', city: 'Bengaluru', zip: '560048', province: 'Karnataka', province_code: 'KA' };
    return i;
}

const build = (i: InvoiceDocumentInput) => buildInvoiceDocument(i);
const detail = (i: InvoiceDocumentInput, label: string) => build(i).details.find((d) => d.label === label)?.value;

describe('buildInvoiceDocument', () => {
    it('the mock-up’s paid B2C invoice, field by field', () => {
        expect(build(base())).toEqual({
            kind: 'TAX_INVOICE',
            theme: 'modern',
            brandColor: null,
            documentNumber: 'INV-26-27/000124',
            title: 'TAX INVOICE',
            subtitle: null,
            copyMark: 'ORIGINAL FOR RECIPIENT',
            seller: {
                tradeName: 'Saanjh',
                legalName: 'Saanjh Apparel Private Limited',
                addressLines: ['No. 12, 100 Feet Road, Indiranagar', 'Bengaluru 560038, Karnataka'],
                contactLine: '+91 80 4000 0000 · care@saanjh.example · saanjh.example',
                gstin: '29ABCDE1234F1Z5',
                state: 'Karnataka (29)',
                ids: [{ label: 'PAN', value: 'ABCDE1234F' }],
                dispatchFrom: null,
                logo: LOGO,
            },
            status: { chip: { text: 'PAID', tone: 'paid' }, line: 'Paid on 25 Oct 2026', amount: 5647, note: 'UPI via Razorpay' },
            details: [
                { label: 'Invoice No.', value: 'INV-26-27/000124' },
                { label: 'Invoice date', value: '27 Oct 2026' },
                { label: 'Order No.', value: '#1042' },
                { label: 'Order date', value: '25 Oct 2026' },
                { label: 'Payment', value: 'Prepaid (UPI via Razorpay)' },
                { label: 'Place of supply', value: 'Kerala (32)' },
                { label: 'Supply type', value: 'Inter-state (IGST)' },
                { label: 'Reverse charge', value: 'No' },
                { label: 'Courier', value: 'Delhivery' },
                { label: 'AWB', value: '1490000000000' },
            ],
            reference: [],
            parties: [
                {
                    heading: 'BILL TO / SHIP TO',
                    name: 'Asha Menon',
                    lines: ['Flat 4B, Palm Grove Apartments, Kadavanthra', 'Kochi 682020, Kerala'],
                    state: 'Kerala (32)',
                    gstin: null,
                },
            ],
            taxHeads: 'IGST',
            showHsn: true,
            showDiscount: true,
            lines: [
                {
                    index: 1, name: 'Handblock Cotton Kurta', detail: 'Indigo / M · SJ-KUR-IND-M', hsn: '6211', quantity: '1 PCS', rate: 1427.62, discount: 142.86,
                    taxable: 1284.76, cgst: null, sgst: null, igst: { amount: 64.24, rate: 5 }, amount: 1349,
                },
                {
                    index: 2, name: 'Linen Palazzo Pants', detail: 'Beige / M · SJ-PLZ-BEI-M', hsn: '6204', quantity: '1 PCS', rate: 1237.14, discount: 0,
                    taxable: 1237.14, cgst: null, sgst: null, igst: { amount: 61.86, rate: 5 }, amount: 1299,
                },
                {
                    index: 3, name: 'Pure Silk Dupatta', detail: 'Rust · SJ-DUP-RST', hsn: '6214', quantity: '1 PCS', rate: 2541.53, discount: 0,
                    taxable: 2541.53, cgst: null, sgst: null, igst: { amount: 457.47, rate: 18 }, amount: 2999,
                },
            ],
            totals: {
                quantity: 3,
                itemValue: 5206.29,
                discount: 142.86,
                taxable: 5063.43,
                cgst: 0,
                sgst: 0,
                igst: 583.57,
                charges: [],
                roundOff: 0,
                grandLabel: 'Grand total',
                grandTotal: 5647,
                paid: null,
                balanceDue: null,
            },
            amountInWords: 'Rupees Five Thousand Six Hundred Forty-Seven Only',
            taxSummary: {
                rows: [
                    { hsn: '6204', rate: 5, taxable: 1237.14, cgst: 0, sgst: 0, igst: 61.86, totalTax: 61.86 },
                    { hsn: '6211', rate: 5, taxable: 1284.76, cgst: 0, sgst: 0, igst: 64.24, totalTax: 64.24 },
                    { hsn: '6214', rate: 18, taxable: 2541.53, cgst: 0, sgst: 0, igst: 457.47, totalTax: 457.47 },
                ],
                total: { taxable: 5063.43, cgst: 0, sgst: 0, igst: 583.57, totalTax: 583.57 },
            },
            payment: { kind: 'received', lines: ['UPI via Razorpay · Txn ID pay_SAMPLE7Hx2 · 25 Oct 2026, 18:42 · ₹5,647.00'] },
            terms: [],
            returns: null,
            declaration: null,
            notes: null,
            signatory: null,
            footer: {
                lines: ['Questions about this order? WhatsApp +91 90000 00000 · care@saanjh.example'],
                computerGenerated: 'This is a computer-generated invoice and does not need a signature.',
                note: 'Thank you for shopping with us.',
            },
            cancelled: null,
            currency: 'INR',
        });
    });

    describe('kind, title, subtitle and copy mark', () => {
        it('a credit note whatever its snapshot; a bill of supply or tax invoice from the snapshot', () => {
            const bos = base();
            bos.snapshot.documentType = 'BILL_OF_SUPPLY';
            expect(build(bos)).toMatchObject({ kind: 'BILL_OF_SUPPLY', title: 'BILL OF SUPPLY', copyMark: 'ORIGINAL FOR RECIPIENT' });

            const note = creditNote();
            note.snapshot.documentType = 'BILL_OF_SUPPLY';
            expect(build(note)).toMatchObject({ kind: 'CREDIT_NOTE', title: 'CREDIT NOTE', copyMark: 'ORIGINAL FOR RECIPIENT', taxHeads: null });
        });

        it('a document issued before snapshots is an ordinary tax invoice in the current settings', () => {
            const i = base();
            i.snapshot = currentSnapshot(design({ theme: 'classic' }), BRAND);
            expect(build(i)).toMatchObject({ kind: 'TAX_INVOICE', title: 'TAX INVOICE', subtitle: null, theme: 'classic', declaration: null });
        });

        it('a cancelled invoice keeps its title', () => {
            const i = base();
            i.invoice.status = 'CANCELLED';
            i.invoice.cancelledAt = new Date('2026-10-27T05:00:00Z');
            expect(build(i)).toMatchObject({ kind: 'TAX_INVOICE', title: 'TAX INVOICE' });
        });

        it('composition: the Rule 5(1)(f) line under the title, word for word', () => {
            const i = base();
            i.snapshot = { ...i.snapshot, documentType: 'BILL_OF_SUPPLY', composition: true };
            expect(build(i).subtitle).toBe('Composition taxable person, not eligible to collect tax on supplies');
            expect(build(base()).subtitle).toBeNull();
        });
    });

    describe('theme', () => {
        it('Classic for a GST-registered buyer when the settings ask for it', () => {
            expect(build(business()).theme).toBe('classic');
            const own = business();
            own.snapshot.design = design({ classicForB2b: false, theme: 'modern' });
            expect(build(own).theme).toBe('modern');
        });

        it('the chosen theme and colour otherwise', () => {
            const i = base();
            i.snapshot.design = design({ theme: 'classic', brandColor: '#0F766E' });
            expect(build(i)).toMatchObject({ theme: 'classic', brandColor: '#0F766E' });
        });
    });

    describe('seller', () => {
        it('no trade name when it is the legal name, ignoring case', () => {
            const i = base();
            i.snapshot.brand.tradeName = '  saanjh apparel private limited ';
            expect(build(i).seller.tradeName).toBeNull();
        });

        it('no contact line when the settings hide it, or nothing is filled in', () => {
            const hidden = base();
            hidden.snapshot.design = design({ showSupportContact: false });
            expect(build(hidden).seller.contactLine).toBeNull();
            const blank = base();
            blank.snapshot.brand = { ...BRAND, supportPhone: '', supportEmail: ' ', website: '' };
            expect(build(blank).seller.contactLine).toBeNull();
        });

        it('PAN when shown, then the IDs meant for A4 with their labels', () => {
            const i = base();
            i.snapshot.design = design({
                businessIds: [
                    { type: 'CIN', value: 'U18101KA2021PTC000000' },
                    { type: 'FSSAI', value: '11223344556677' },
                    { type: 'UDYAM', value: 'UDYAM-KR-03-0012345' },
                    { type: 'IEC', value: '0512345678' },
                    { type: 'LUT', value: 'AD290326000123X', onA4: false, onReceipt: true },
                    { type: 'DL', value: 'KA-B2-123456' },
                ],
            });
            expect(build(i).seller.ids).toEqual([
                { label: 'PAN', value: 'ABCDE1234F' },
                { label: 'CIN', value: 'U18101KA2021PTC000000' },
                { label: 'FSSAI Lic. No.', value: '11223344556677' },
                { label: 'Udyam Reg. No.', value: 'UDYAM-KR-03-0012345' },
                { label: 'IEC', value: '0512345678' },
                { label: 'D.L. No.', value: 'KA-B2-123456' },
            ]);
            i.snapshot.design = design({ showPan: false, businessIds: [{ type: 'CUSTOM', label: 'Shop Reg.', value: 'BLR-42' }] });
            expect(build(i).seller.ids).toEqual([{ label: 'Shop Reg.', value: 'BLR-42' }]);
        });

        it('where the goods were dispatched from, when that is not the registered address', () => {
            const i = base();
            i.invoice.dispatchName = 'Whitefield warehouse';
            i.invoice.dispatchAddress = { address1: 'Plot 7, EPIP Zone', city: 'Bengaluru', zip: '560066', province: 'Karnataka' };
            expect(build(i).seller.dispatchFrom).toBe('Dispatched from: Whitefield warehouse, Plot 7, EPIP Zone, Bengaluru 560066, Karnataka');
            i.invoice.dispatchAddress = i.invoice.sellerAddress;
            expect(build(i).seller.dispatchFrom).toBeNull();
        });

        it('prints without a logo when there is none', () => {
            const i = base();
            i.logo = null;
            expect(build(i).seller.logo).toBeNull();
        });
    });

    describe('status', () => {
        it('cancelled: the void chip and when', () => {
            const i = base();
            i.invoice.status = 'CANCELLED';
            i.invoice.cancelledAt = new Date('2026-10-27T05:00:00Z');
            const doc = build(i);
            expect(doc.status).toEqual({ chip: { text: 'CANCELLED', tone: 'void' }, line: 'Cancelled on 27 Oct 2026', amount: 5647, note: null });
            expect(doc.cancelled).toEqual({ on: '27 Oct 2026' });
            expect(doc.payment).toBeNull();
            expect(doc.totals).toMatchObject({ paid: null, balanceDue: null });
        });

        it('a credit note: no chip, what it is against, the amount credited', () => {
            expect(build(creditNote()).status).toEqual({ chip: null, line: 'Against INV-26-27/000124', amount: 1500, note: null });
        });

        it('a cancelled credit note stays a credit note, signed, with the void chip', () => {
            const i = creditNote();
            i.invoice.status = 'CANCELLED';
            i.invoice.cancelledAt = new Date('2026-10-29T05:00:00Z');
            const doc = build(i);
            expect(doc).toMatchObject({
                kind: 'CREDIT_NOTE',
                title: 'CREDIT NOTE',
                status: { chip: { text: 'CANCELLED', tone: 'void' }, line: 'Cancelled on 29 Oct 2026', amount: 1500, note: null },
                reference: ['Against invoice INV-26-27/000124 dated 27 Oct 2026', 'Reason: Returned: Pure Silk Dupatta'],
                totals: { grandLabel: 'Amount credited' },
                payment: null,
                cancelled: { on: '29 Oct 2026' },
            });
            expect(doc.signatory?.forName).toBe('For Saanjh Apparel Private Limited');
            expect(doc.details.map((d) => d.label)).toEqual(['Credit note No.', 'Credit note date', 'Order No.', 'Order date', 'Place of supply', 'Supply type', 'Reverse charge']);
        });

        it('paid at the till: the date of the last payment and the methods', () => {
            const i = base();
            i.order = {
                ...i.order,
                posSale: true,
                paymentGateways: [],
                paymentMethod: 'UPI',
                paymentLink: null,
                payments: [
                    { method: 'UPI', amount: 1500, reference: '629312345678', createdAt: new Date('2026-10-26T09:00:00Z') },
                    { method: 'CASH', amount: 4147, reference: null, createdAt: new Date('2026-10-26T10:40:00Z') },
                ],
            };
            const doc = build(i);
            expect(doc.status).toEqual({ chip: { text: 'PAID', tone: 'paid' }, line: 'Paid on 26 Oct 2026', amount: 5647, note: 'UPI + Cash' });
            expect(doc.details).toContainEqual({ label: 'Payment', value: 'Paid (UPI + Cash)' });
            expect(doc.payment).toEqual({
                kind: 'received',
                lines: ['UPI · Ref 629312345678 · 26 Oct 2026, 14:30 · ₹1,500.00', 'Cash · 26 Oct 2026, 16:10 · ₹4,147.00'],
            });
        });

        it('paid with no date known: no "Paid on" line; the gateway as the note', () => {
            const i = base();
            i.order.paymentLink = null;
            i.order.paidEventAt = null;
            expect(build(i).status).toEqual({ chip: { text: 'PAID', tone: 'paid' }, line: null, amount: 5647, note: 'Razorpay' });
            i.order.paidEventAt = new Date('2026-10-25T20:00:00Z');
            expect(build(i).status.line).toBe('Paid on 26 Oct 2026');
        });

        it('cash on delivery, not paid: collect on delivery, the balance, and no UPI QR', () => {
            const i = unpaid();
            i.order.paymentGateways = ['Cash on Delivery (COD)'];
            const doc = build(i);
            expect(doc.status).toEqual({ chip: { text: 'CASH ON DELIVERY', tone: 'due' }, line: 'Collect on delivery', amount: 5647, note: null });
            expect(doc.details).toContainEqual({ label: 'Payment', value: 'Cash on delivery' });
            expect(doc.payment).toEqual({ kind: 'due', amount: 5647, upiUri: null, upiId: null });
        });

        it('a cash-on-delivery order paid online by a payment link reads as paid online', () => {
            const i = base();
            i.order.paymentGateways = ['Cash on Delivery (COD)'];
            const doc = build(i);
            expect(doc.status.note).toBe('UPI via Razorpay');
            expect(doc.details).toContainEqual({ label: 'Payment', value: 'Prepaid (UPI via Razorpay)' });
        });

        it('unpaid: the whole amount is the balance', () => {
            const doc = build(unpaid());
            expect(doc.status).toEqual({ chip: { text: 'UNPAID', tone: 'due' }, line: null, amount: 5647, note: null });
            expect(doc.details).toContainEqual({ label: 'Payment', value: 'Unpaid' });
            expect(doc.totals).toMatchObject({ paid: 0, balanceDue: 5647 });
        });

        it('part paid at the till: the balance, with what was paid in the totals', () => {
            const i = unpaid();
            i.order.financialStatus = 'PARTIALLY_PAID';
            i.order.posSale = true;
            i.order.payments = [{ method: 'CASH', amount: 2000, reference: null, createdAt: new Date('2026-10-26T09:00:00Z') }];
            const doc = build(i);
            expect(doc.status).toEqual({ chip: { text: 'PARTLY PAID', tone: 'due' }, line: 'Balance due', amount: 3647, note: null });
            expect(doc.details).toContainEqual({ label: 'Payment', value: 'Partly paid' });
            expect(doc.totals).toMatchObject({ grandTotal: 5647, paid: 2000, balanceDue: 3647 });
            expect(doc.payment).toMatchObject({ kind: 'due', amount: 3647 });
        });

        it('part paid on a channel that did not say how much: no balance and no QR it could not know', () => {
            const i = unpaid();
            i.order.financialStatus = 'PARTIALLY_PAID';
            const doc = build(i);
            expect(doc.status).toEqual({ chip: { text: 'PARTLY PAID', tone: 'due' }, line: null, amount: 5647, note: null });
            expect(doc.totals).toMatchObject({ paid: null, balanceDue: null });
            expect(doc.payment).toBeNull();
        });

        it('refunded orders were paid: the refund is its own credit note', () => {
            for (const financialStatus of ['REFUNDED', 'PARTIALLY_REFUNDED'] as const) {
                const i = base();
                i.order.financialStatus = financialStatus;
                expect(build(i).status.chip).toEqual({ text: 'PAID', tone: 'paid' });
            }
        });
    });

    describe('details', () => {
        it('no order date when the order was placed the day it was invoiced', () => {
            const i = base();
            i.order.placedAt = new Date('2026-10-27T10:00:00Z');
            expect(detail(i, 'Order date')).toBeUndefined();
        });

        it('a payment method of an order made in Collabo', () => {
            const i = base();
            i.order = { ...i.order, paymentGateways: [], paymentLink: null, paymentMethod: 'CASH' };
            expect(detail(i, 'Payment')).toBe('Paid (Cash)');
        });

        it('intra-state, and reverse charge when it applies', () => {
            const i = business();
            i.invoice.reverseCharge = true;
            expect(detail(i, 'Supply type')).toBe('Intra-state');
            expect(detail(i, 'Reverse charge')).toBe('Yes');
        });

        it('a bill of supply: bill number and date, no supply type and no reverse charge', () => {
            const i = base();
            i.snapshot.documentType = 'BILL_OF_SUPPLY';
            expect(build(i).details.map((d) => d.label)).toEqual(['Bill No.', 'Bill date', 'Order No.', 'Order date', 'Payment', 'Place of supply', 'Courier', 'AWB']);
        });

        it('a credit note: its own number and date, nothing of the sale’s payment or shipment', () => {
            expect(build(creditNote()).details).toEqual([
                { label: 'Credit note No.', value: 'CN-26-27/000009' },
                { label: 'Credit note date', value: '28 Oct 2026' },
                { label: 'Order No.', value: '#1042' },
                { label: 'Order date', value: '25 Oct 2026' },
                { label: 'Place of supply', value: 'Kerala (32)' },
                { label: 'Supply type', value: 'Inter-state (IGST)' },
                { label: 'Reverse charge', value: 'No' },
            ]);
        });

        it('only the tracking that exists', () => {
            const i = base();
            i.order.tracking = { company: null, number: 'AWB123' };
            expect(build(i).details.slice(-1)).toEqual([{ label: 'AWB', value: 'AWB123' }]);
            i.order.tracking = null;
            expect(detail(i, 'Courier')).toBeUndefined();
        });
    });

    describe('credit note', () => {
        it('names the invoice it is against and why', () => {
            expect(build(creditNote()).reference).toEqual(['Against invoice INV-26-27/000124 dated 27 Oct 2026', 'Reason: Returned: Pure Silk Dupatta']);
            const noReason = creditNote();
            noReason.invoice.creditNoteReason = '  ';
            expect(build(noReason).reference).toEqual(['Against invoice INV-26-27/000124 dated 27 Oct 2026']);
        });

        it('credits value, not units: no quantity, totals that still add up, "Amount credited"', () => {
            const doc = build(creditNote());
            expect(doc.lines.map((l) => l.quantity)).toEqual(['–', '–', '–']);
            expect(doc.totals).toMatchObject({ quantity: null, itemValue: 1387.51, discount: 37.95, taxable: 1349.56, igst: 150.44, grandLabel: 'Amount credited', grandTotal: 1500 });
            expect(doc.amountInWords).toBe('Rupees One Thousand Five Hundred Only');
            expect(doc.payment).toBeNull();
        });

        it('is always signed: the uploaded signature, or space to sign', () => {
            const note = creditNote();
            note.snapshot.design = design({ signatoryName: 'Meera Rao', signatoryDesignation: 'Director' });
            const unsigned = build(note);
            expect(unsigned.signatory).toEqual({ forName: 'For Saanjh Apparel Private Limited', image: null, name: 'Meera Rao', designation: 'Director' });
            expect(unsigned.footer.computerGenerated).toBeNull();
            note.signature = SIGNATURE;
            expect(build(note).signatory?.image).toBe(SIGNATURE);
        });
    });

    describe('parties', () => {
        it('Bill to and Ship to side by side when the order ships elsewhere', () => {
            expect(build(business()).parties).toEqual([
                { heading: 'BILL TO', name: 'Kavya Retail LLP', lines: ['45, Commercial Street', 'Bengaluru 560001, Karnataka'], state: 'Karnataka (29)', gstin: '29AAAFK0000A1Z5' },
                { heading: 'SHIP TO', name: 'Kavya Retail LLP (Whitefield store)', lines: ['Unit 12, Phoenix Marketcity', 'Bengaluru 560048, Karnataka'], state: 'Karnataka (29)', gstin: null },
            ]);
        });

        it('one block when the addresses read the same, or the order has none to ship to', () => {
            const i = base();
            i.order.shippingAddress = { address1: 'FLAT 4B, PALM GROVE APARTMENTS', address2: 'Kadavanthra', city: 'Kochi', zip: '682020', province: 'Kerala' };
            expect(build(i).parties.map((p) => p.heading)).toEqual(['BILL TO / SHIP TO']);
            i.order.shippingAddress = null;
            expect(build(i).parties.map((p) => p.heading)).toEqual(['BILL TO / SHIP TO']);
        });

        it.each([
            ['hide', ['Flat 4B, Palm Grove Apartments, Kadavanthra', 'Kochi 682020, Kerala']],
            ['mask', ['Flat 4B, Palm Grove Apartments, Kadavanthra', 'Kochi 682020, Kerala', '+91 98••• ••345 · a•••@gmail.com']],
            ['show', ['Flat 4B, Palm Grove Apartments, Kadavanthra', 'Kochi 682020, Kerala', '+919847012345 · asha.menon@gmail.com']],
        ])('the buyer’s phone and email: %s', (customerContact, lines) => {
            const i = base();
            i.snapshot.design = design({ customerContact });
            expect(build(i).parties[0].lines).toEqual(lines);
        });

        it('the phone from the billing address when the customer has none', () => {
            const i = base();
            i.snapshot.design = design({ customerContact: 'show' });
            i.order.customer = null;
            i.invoice.buyerAddress = { address1: 'Flat 4B', city: 'Kochi', phone: '+91 98470 12345' };
            expect(build(i).parties[0].lines).toEqual(['Flat 4B', 'Kochi', '+91 98470 12345']);
        });
    });

    describe('tax heads and lines', () => {
        it('IGST, CGST and SGST, or CGST and UTGST for a Union territory without a legislature', () => {
            expect(build(base()).taxHeads).toBe('IGST');
            expect(build(business()).taxHeads).toBe('CGST_SGST');
            for (const code of ['04', '26', '31', '35', '38', '97']) {
                const i = business();
                i.invoice.sellerStateCode = code;
                expect(build(i).taxHeads).toBe('CGST_UTGST');
            }
            const delhi = business();
            delhi.invoice.sellerStateCode = '07';
            expect(build(delhi).taxHeads).toBe('CGST_SGST');
        });

        it('a bill of supply has no tax heads, no tax cells and no summary, but keeps HSN', () => {
            const i = base();
            i.snapshot.documentType = 'BILL_OF_SUPPLY';
            const doc = build(i);
            expect(doc).toMatchObject({ taxHeads: null, showHsn: true, taxSummary: null });
            expect(doc.lines.every((l) => l.cgst === null && l.sgst === null && l.igst === null)).toBe(true);
        });

        it('tax cells only for the heads in use', () => {
            const [row] = build(business()).lines;
            expect(row).toMatchObject({ cgst: { amount: 70.5, rate: 2.5 }, sgst: { amount: 70.5, rate: 2.5 }, igst: null, quantity: '6 PCS' });
        });

        it('the SKU only when the settings show it; the stored description when the order line is gone', () => {
            const i = base();
            i.snapshot.design = design({ showSku: false });
            i.order.lineItems = i.order.lineItems.slice(1);
            const [gone, kept] = build(i).lines;
            expect(gone).toMatchObject({ name: 'Handblock Cotton Kurta - Indigo / M', detail: null });
            expect(kept).toMatchObject({ name: 'Linen Palazzo Pants', detail: 'Beige / M' });
        });

        it('Shopify’s "Default Title" is not a variant', () => {
            const i = base();
            i.order.lineItems[0].variantTitle = 'Default Title';
            expect(build(i).lines[0].detail).toBe('SJ-KUR-IND-M');
        });

        it('the line’s unit, else the tax settings’ default; a mixed table has no total quantity', () => {
            const i = base();
            i.invoice.lineItems[1].unitOfMeasure = null;
            const doc = build(i);
            expect(doc.lines.map((l) => l.quantity)).toEqual(['1 PCS', '1 NOS', '1 PCS']);
            expect(doc.totals.quantity).toBeNull();
        });

        it('the old "0000" HSN prints as missing', () => {
            const i = base();
            i.invoice.lineItems[0].hsnCode = '0000';
            expect(build(i).lines[0].hsn).toBeNull();
        });

        it('no discount column when no line has one', () => {
            const i = base();
            i.invoice.lineItems[0] = { ...i.invoice.lineItems[0], discount: 0, unitPrice: 1284.76 };
            expect(build(i).showDiscount).toBe(false);
        });
    });

    describe('totals', () => {
        it('shipping added untaxed, as "Shipping (not taxed)"', () => {
            const i = base();
            i.invoice.shippingCharge = 99;
            i.invoice.grandTotal = 5746;
            expect(build(i).totals.charges).toEqual([{ label: 'Shipping (not taxed)', amount: 99 }]);
        });

        it('shipping taxed into the lines is not added again, though older invoices still store it', () => {
            const i = base();
            i.invoice.shippingCharge = 99;
            expect(build(i).totals.charges).toEqual([]);
        });
    });

    describe('amount in words', () => {
        it('only when the settings print it, and only in rupees', () => {
            const off = base();
            off.snapshot.design = design({ amountInWords: false });
            expect(build(off).amountInWords).toBeNull();
            const dollars = base();
            dollars.invoice.currency = 'USD';
            expect(build(dollars).amountInWords).toBeNull();
            const paise = base();
            paise.invoice.grandTotal = 5647.5;
            expect(build(paise).amountInWords).toBe('Rupees Five Thousand Six Hundred Forty-Seven and Fifty Paise Only');
        });
    });

    describe('tax summary', () => {
        const oneRate = (i: InvoiceDocumentInput) => {
            i.invoice.lineItems = [i.invoice.lineItems[1]];
            return i;
        };

        it('auto: only when there is more than one HSN and rate', () => {
            expect(build(base()).taxSummary?.rows).toHaveLength(3);
            expect(build(oneRate(base())).taxSummary).toBeNull();
        });

        it('always and never, as the settings say, on a B2C document', () => {
            const always = oneRate(base());
            always.snapshot.design = design({ taxSummary: 'always' });
            expect(build(always).taxSummary?.rows).toHaveLength(1);
            const never = base();
            never.snapshot.design = design({ taxSummary: 'never' });
            expect(build(never).taxSummary).toBeNull();
        });

        it('a B2B document always carries it', () => {
            const i = business();
            i.snapshot.design = design({ taxSummary: 'never' });
            expect(build(i).taxSummary).toEqual({
                rows: [{ hsn: '6211', rate: 5, taxable: 2820, cgst: 70.5, sgst: 70.5, igst: 0, totalTax: 141 }],
                total: { taxable: 2820, cgst: 70.5, sgst: 70.5, igst: 0, totalTax: 141 },
            });
        });

        it('one row per HSN and rate, sorted by HSN then rate', () => {
            const i = base();
            i.invoice.lineItems = [
                line({ hsnCode: '6211', gstRate: 18, taxableValue: 100, igstAmount: 18 }),
                line({ hsnCode: '6204', gstRate: 5, taxableValue: 200, igstAmount: 10 }),
                line({ hsnCode: '6211', gstRate: 5, taxableValue: 300, igstAmount: 15 }),
                line({ hsnCode: '6211', gstRate: 5, taxableValue: 400, igstAmount: 20 }),
                line({ hsnCode: null, gstRate: 5, taxableValue: 50, igstAmount: 2.5 }),
            ];
            expect(build(i).taxSummary?.rows.map((r) => [r.hsn, r.rate, r.taxable, r.igst])).toEqual([
                ['6204', 5, 200, 10],
                ['6211', 5, 700, 35],
                ['6211', 18, 100, 18],
                ['–', 5, 50, 2.5],
            ]);
        });
    });

    describe('payment', () => {
        it('due: a UPI QR for the balance, its link URL-encoded', () => {
            expect(build(unpaid()).payment).toEqual({
                kind: 'due',
                amount: 5647,
                upiUri: 'upi://pay?pa=saanjh@okaxis&pn=Saanjh&am=5647.00&cu=INR&tn=INV-26-27%2F000124',
                upiId: 'saanjh@okaxis',
            });
            const named = unpaid();
            named.snapshot.brand.tradeName = 'Saanjh & Co';
            expect((build(named).payment as { upiUri: string }).upiUri).toContain('pn=Saanjh%20%26%20Co&');
        });

        it('no QR while a gateway holds an authorised payment, or for a voided one: nothing to pay twice', () => {
            for (const financialStatus of ['AUTHORIZED', 'VOIDED'] as const) {
                const i = unpaid();
                i.order.financialStatus = financialStatus;
                expect(build(i).payment).toEqual({ kind: 'due', amount: 5647, upiUri: null, upiId: null });
            }
            const part = unpaid();
            part.order.financialStatus = 'PARTIALLY_PAID';
            part.order.payments = [{ method: 'CASH', amount: 1000, reference: null, createdAt: new Date('2026-10-26T09:00:00Z') }];
            expect(build(part).payment).toMatchObject({ kind: 'due', amount: 4647, upiId: 'saanjh@okaxis' });
        });

        it('no QR when the settings say never, or there is no UPI id', () => {
            const never = unpaid();
            never.snapshot.design = design({ upiQr: 'never' });
            expect(build(never).payment).toEqual({ kind: 'due', amount: 5647, upiUri: null, upiId: null });
            const none = unpaid();
            none.snapshot.brand.upiId = null;
            expect(build(none).payment).toEqual({ kind: 'due', amount: 5647, upiUri: null, upiId: null });
        });

        it('an order paid on its channel: the gateway and the amount', () => {
            const i = base();
            i.order.paymentLink = null;
            i.order.paymentGateways = ['shopify_payments'];
            expect(build(i).payment).toEqual({ kind: 'received', lines: ['Shopify payments · ₹5,647.00'] });
            i.order.paymentGateways = [];
            expect(build(i).payment).toEqual({ kind: 'received', lines: ['₹5,647.00'] });
        });

        it('paid in cash on delivery', () => {
            const i = base();
            i.order.paymentLink = null;
            i.order.paymentGateways = ['Cash on Delivery (COD)'];
            expect(build(i).payment).toEqual({ kind: 'received', lines: ['Cash on delivery · ₹5,647.00'] });
            expect(build(i).status.note).toBe('Cash on delivery');
        });
    });

    describe('terms, returns, declaration and notes', () => {
        it('terms one per line, trimmed, blanks dropped', () => {
            const i = base();
            i.snapshot.design = design({ terms: ' Payment within 15 days. \r\n\n  Interest at 18% after that.\n ' });
            expect(build(i).terms).toEqual(['Payment within 15 days.', 'Interest at 18% after that.']);
        });

        it('the return policy, then its link; null when both are blank', () => {
            const i = base();
            i.snapshot.design = design({ returnPolicy: 'Returns within 15 days.', returnPolicyUrl: 'https://saanjh.example/returns' });
            expect(build(i).returns).toBe('Returns within 15 days. https://saanjh.example/returns');
            i.snapshot.design = design({ returnPolicyUrl: 'https://saanjh.example/returns' });
            expect(build(i).returns).toBe('https://saanjh.example/returns');
        });

        it('the Rule 46(s) declaration, word for word, when e-invoicing was on and there is no IRN', () => {
            const i = base();
            i.snapshot.eInvoiceDeclaration = true;
            expect(build(i).declaration).toBe(
                'I/We hereby declare that though our aggregate turnover in any preceding financial year from 2017-18 onwards is more than the aggregate turnover notified under sub-rule (4) of rule 48, we are not required to prepare an invoice in terms of the provisions of the said sub-rule.',
            );
        });

        it('the invoice’s own notes', () => {
            const i = base();
            i.invoice.notes = ' Gift wrapped. ';
            expect(build(i).notes).toBe('Gift wrapped.');
        });
    });

    describe('signatory and footer', () => {
        it('a tax invoice: no block in computer mode, the note in the footer instead', () => {
            const doc = build(base());
            expect(doc.signatory).toBeNull();
            expect(doc.footer.computerGenerated).toBe('This is a computer-generated invoice and does not need a signature.');
        });

        it('image mode: the uploaded signature; blank mode: space to sign', () => {
            const image = base();
            image.snapshot.design = design({ signatureMode: 'image', signatoryName: 'Meera Rao' });
            image.signature = SIGNATURE;
            expect(build(image).signatory).toEqual({ forName: 'For Saanjh Apparel Private Limited', image: SIGNATURE, name: 'Meera Rao', designation: null });
            expect(build(image).footer.computerGenerated).toBeNull();

            const blank = base();
            blank.snapshot.design = design({ signatureMode: 'blank' });
            blank.signature = SIGNATURE;
            expect(build(blank).signatory).toEqual({ forName: 'For Saanjh Apparel Private Limited', image: null, name: null, designation: null });
        });

        it('a bill of supply says "bill"', () => {
            const i = base();
            i.snapshot.documentType = 'BILL_OF_SUPPLY';
            expect(build(i).footer.computerGenerated).toBe('This is a computer-generated bill and does not need a signature.');
        });

        it('the registered office with the CIN, the support line, and the brand’s note', () => {
            const i = base();
            i.snapshot.design = design({
                registeredOffice: 'No. 12, 100 Feet Road, Indiranagar, Bengaluru 560038',
                businessIds: [{ type: 'CIN', value: 'U18101KA2021PTC000000' }],
                footerNote: '  ',
            });
            expect(build(i).footer).toEqual({
                lines: [
                    'Registered office: No. 12, 100 Feet Road, Indiranagar, Bengaluru 560038 · CIN U18101KA2021PTC000000',
                    'Questions about this order? WhatsApp +91 90000 00000 · care@saanjh.example',
                ],
                computerGenerated: 'This is a computer-generated invoice and does not need a signature.',
                note: null,
            });
        });

        it('no support line when the settings hide contacts or there is no WhatsApp or email', () => {
            const hidden = base();
            hidden.snapshot.design = design({ showSupportContact: false });
            expect(build(hidden).footer.lines).toEqual([]);
            const phoneOnly = base();
            phoneOnly.snapshot.brand = { ...BRAND, whatsappPhone: '', supportEmail: '' };
            expect(build(phoneOnly).footer.lines).toEqual([]);
        });
    });
});

describe('invoicePdfFilename', () => {
    it('names the file after the number, safe as a file name', () => {
        expect(invoicePdfFilename('INV-26-27/000124')).toBe('INV-26-27-000124.pdf');
        expect(invoicePdfFilename('CN-26-27/000009')).toBe('CN-26-27-000009.pdf');
        expect(invoicePdfFilename('A:B*C?')).toBe('A-B-C-.pdf');
    });
});
