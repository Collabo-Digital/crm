import { InvoiceSettingsSchema } from '../../organization-settings/schemas/invoice-settings.schema';
import { billPdfFilename, buildBillDocument, type BillContext, type BillReceipt } from './build-bill-document';
import type { DocImage } from './document-model';

/**
 * A till sale with no GST invoice as an A4 bill: the receipt the till prints
 * (PosReceiptService.receipt), in the current settings.
 */

const LOGO: DocImage = { data: Buffer.from('logo'), format: 'png' };

function context(design: Record<string, unknown> = {}): BillContext {
    return {
        design: InvoiceSettingsSchema.parse(design),
        brand: {
            tradeName: 'Acme Store',
            logoStorageKey: 'org_1/logo.png',
            supportPhone: '+91 80 4000 0000',
            whatsappPhone: '+91 90000 00000',
            supportEmail: 'hello@acme.example',
            website: 'acme.example',
            upiId: 'acme@okaxis',
        },
        logo: LOGO,
        timeZone: 'Asia/Kolkata',
        currency: 'INR',
    };
}

/** A walk-in's sale at a store without GST, rounded up and part paid. */
function receipt(): BillReceipt {
    return {
        footer: 'No exchange after 7 days.',
        store: { name: 'Acme Store', legalName: null, address: '12 MG Road, Bengaluru, Karnataka 560001', gstin: null },
        order: { name: '#M1002', createdAt: '2026-10-26T19:00:00.000Z', staffName: 'Ravi', storeName: 'MG Road' },
        customer: null,
        lines: [
            { title: 'Handloom saree', variantTitle: null, hsn: null, quantity: 1, unitPrice: 999.6, discount: 0 },
            { title: 'Cotton socks', variantTitle: 'Default Title', hsn: null, quantity: 2, unitPrice: 30, discount: 10 },
        ],
        totals: { subtotal: 1059.6, discount: 10, roundOff: 0.4, total: 1049.6, payable: 1050 },
        payments: [{ method: 'CASH', amount: 500, reference: null, at: '2026-10-26T19:05:00.000Z' }],
        paid: 500,
        balanceDue: 550,
    };
}

/** The same sale paid in full by UPI and cash. */
function paid(): BillReceipt {
    return {
        ...receipt(),
        payments: [
            { method: 'UPI', amount: 600, reference: '629312345678', at: '2026-10-26T19:05:00.000Z' },
            { method: 'CASH', amount: 450, reference: null, at: '2026-10-26T19:06:00.000Z' },
        ],
        paid: 1050,
        balanceDue: 0,
    };
}

describe('buildBillDocument', () => {
    it('a part-paid walk-in sale, field by field', () => {
        expect(buildBillDocument(receipt(), context())).toEqual({
            kind: 'BILL',
            theme: 'modern',
            brandColor: null,
            documentNumber: '#M1002',
            title: 'BILL',
            subtitle: null,
            copyMark: null,
            seller: {
                tradeName: null,
                legalName: 'Acme Store',
                addressLines: ['12 MG Road, Bengaluru, Karnataka 560001'],
                contactLine: '+91 80 4000 0000 · hello@acme.example · acme.example',
                gstin: null,
                state: null,
                ids: [],
                dispatchFrom: null,
                logo: LOGO,
            },
            status: { chip: { text: 'PARTLY PAID', tone: 'due' }, line: 'Balance due', amount: 550, note: null },
            details: [
                { label: 'Bill No.', value: '#M1002' },
                // 00:30 on 27 Oct in India.
                { label: 'Bill date', value: '27 Oct 2026' },
                { label: 'Payment', value: 'Partly paid' },
                { label: 'Billed by', value: 'Ravi' },
                { label: 'Store', value: 'MG Road' },
            ],
            reference: [],
            parties: [{ heading: 'BILL TO', name: 'Walk-in customer', lines: [], state: null, gstin: null }],
            taxHeads: null,
            showHsn: false,
            showDiscount: true,
            lines: [
                { index: 1, name: 'Handloom saree', detail: null, hsn: null, quantity: '1', rate: 999.6, discount: 0, taxable: 999.6, cgst: null, sgst: null, igst: null, amount: 999.6 },
                { index: 2, name: 'Cotton socks', detail: null, hsn: null, quantity: '2', rate: 30, discount: 10, taxable: 50, cgst: null, sgst: null, igst: null, amount: 50 },
            ],
            totals: {
                quantity: 3,
                itemValue: 1059.6,
                discount: 10,
                taxable: 1049.6,
                cgst: 0,
                sgst: 0,
                igst: 0,
                charges: [],
                roundOff: 0.4,
                grandLabel: 'Net payable',
                grandTotal: 1050,
                paid: 500,
                balanceDue: 550,
            },
            amountInWords: 'Rupees One Thousand Fifty Only',
            taxSummary: null,
            payment: { kind: 'due', amount: 550, upiUri: 'upi://pay?pa=acme@okaxis&pn=Acme%20Store&am=550.00&cu=INR&tn=%23M1002', upiId: 'acme@okaxis' },
            terms: [],
            returns: null,
            declaration: null,
            notes: 'No exchange after 7 days.',
            signatory: null,
            footer: {
                lines: ['Questions about this order? WhatsApp +91 90000 00000 · hello@acme.example'],
                computerGenerated: 'This is a computer-generated bill and does not need a signature.',
                note: 'Thank you for shopping with us.',
            },
            cancelled: null,
            currency: 'INR',
        });
    });

    it('paid: the payments as received lines, the date of the last, and the methods', () => {
        const doc = buildBillDocument(paid(), context());
        expect(doc.status).toEqual({ chip: { text: 'PAID', tone: 'paid' }, line: 'Paid on 27 Oct 2026', amount: 1050, note: 'UPI + Cash' });
        expect(doc.details).toContainEqual({ label: 'Payment', value: 'Paid (UPI + Cash)' });
        expect(doc.payment).toEqual({
            kind: 'received',
            lines: ['UPI · Ref 629312345678 · 27 Oct 2026, 00:35 · ₹600.00', 'Cash · 27 Oct 2026, 00:36 · ₹450.00'],
        });
        expect(doc.totals).toMatchObject({ paid: null, balanceDue: null });
    });

    it('nothing paid: unpaid, the whole amount due', () => {
        const doc = buildBillDocument({ ...receipt(), payments: [], paid: 0, balanceDue: 1050 }, context());
        expect(doc.status).toEqual({ chip: { text: 'UNPAID', tone: 'due' }, line: null, amount: 1050, note: null });
        expect(doc.details).toContainEqual({ label: 'Payment', value: 'Unpaid' });
    });

    it('a UPI QR only when the settings ask for one, there is a UPI id, and the bill is in rupees', () => {
        expect(buildBillDocument(receipt(), context({ upiQr: 'never' })).payment).toEqual({ kind: 'due', amount: 550, upiUri: null, upiId: null });
        const noUpi = context();
        noUpi.brand.upiId = null;
        expect(buildBillDocument(receipt(), noUpi).payment).toEqual({ kind: 'due', amount: 550, upiUri: null, upiId: null });
        const dollars = { ...context(), currency: 'USD' };
        expect(buildBillDocument(receipt(), dollars)).toMatchObject({ payment: { upiUri: null }, amountInWords: null, currency: 'USD' });
    });

    it('a store with GST: its GSTIN, state and PAN, and its legal name under the trade name', () => {
        const r = receipt();
        r.store = { ...r.store, legalName: 'Acme Retail Private Limited', gstin: '29AAACA1234A1Z5' };
        expect(buildBillDocument(r, context()).seller).toMatchObject({
            tradeName: 'Acme Store',
            legalName: 'Acme Retail Private Limited',
            gstin: '29AAACA1234A1Z5',
            state: 'Karnataka (29)',
            ids: [{ label: 'PAN', value: 'AAACA1234A' }],
        });
    });

    it('GST charged on top of the prices on a sale with no invoice yet: one line, so the totals add up', () => {
        const r = receipt();
        r.lines = [{ title: 'Linen shirt', variantTitle: 'M', hsn: '6205', quantity: 2, unitPrice: 1000, discount: 100 }];
        r.totals = { subtotal: 2000, discount: 100, roundOff: 0, total: 1995, payable: 1995 };
        const doc = buildBillDocument(r, context());
        expect(doc.lines[0]).toMatchObject({ detail: 'M', taxable: 1900, amount: 1900 });
        expect(doc.totals).toMatchObject({ itemValue: 2000, discount: 100, charges: [{ label: 'GST', amount: 95 }], grandTotal: 1995 });
    });

    it('prices that include GST need no such line', () => {
        const r = receipt();
        r.lines = [{ title: 'Linen shirt', variantTitle: 'M', hsn: '6205', quantity: 2, unitPrice: 1000, discount: 100 }];
        r.totals = { subtotal: 2000, discount: 100, roundOff: 0, total: 1900, payable: 1900 };
        expect(buildBillDocument(r, context()).totals).toMatchObject({ charges: [], grandTotal: 1900 });
    });

    it('a named customer, with their number as the settings show it, and Classic for a registered buyer', () => {
        const r = receipt();
        r.customer = { name: 'Kavya Retail LLP', phone: '+919800000001', gstin: '29AAAFK0000A1Z5' };
        const doc = buildBillDocument(r, context({ customerContact: 'mask' }));
        expect(doc.parties).toEqual([{ heading: 'BILL TO', name: 'Kavya Retail LLP', lines: ['+91 98••• ••001'], state: null, gstin: '29AAAFK0000A1Z5' }]);
        expect(doc.theme).toBe('classic');
        expect(buildBillDocument(r, context()).parties[0].lines).toEqual([]);
    });

    it('a walk-in with only a number is still a walk-in', () => {
        const r = receipt();
        r.customer = { name: null, phone: '+919800000001', gstin: null };
        expect(buildBillDocument(r, context({ customerContact: 'show' })).parties[0]).toMatchObject({ name: 'Walk-in customer', lines: ['+919800000001'] });
    });

    it('no "Billed by" or store when the till did not record them, or the store is the shop itself', () => {
        const r = receipt();
        r.order = { ...r.order, staffName: null, storeName: 'Acme Store' };
        expect(buildBillDocument(r, context()).details.map((d) => d.label)).toEqual(['Bill No.', 'Bill date', 'Payment']);
    });

    it('the terms, returns, words and footer follow the current settings', () => {
        const doc = buildBillDocument(
            receipt(),
            context({ terms: 'Goods once sold are exchanged, not refunded.', returnPolicy: 'Exchange within 7 days.', amountInWords: false, footerNote: 'Visit again!', showSupportContact: false }),
        );
        expect(doc).toMatchObject({
            terms: ['Goods once sold are exchanged, not refunded.'],
            returns: 'Exchange within 7 days.',
            amountInWords: null,
            footer: { lines: [], computerGenerated: 'This is a computer-generated bill and does not need a signature.', note: 'Visit again!' },
        });
        expect(doc.seller.contactLine).toBeNull();
    });
});

describe('billPdfFilename', () => {
    it('names the file after the bill, safe as a file name', () => {
        expect(billPdfFilename('#M1042')).toBe('Bill-M1042.pdf');
        expect(billPdfFilename('INV-26-27/000042')).toBe('Bill-INV-26-27-000042.pdf');
        expect(billPdfFilename('A:B*C?')).toBe('Bill-A-B-C.pdf');
    });
});
