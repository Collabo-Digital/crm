import { spawnSync } from 'child_process';
import { join } from 'path';
import { inflateSync } from 'zlib';
import { GstType, Prisma } from '@prisma/client';
import { PosReceiptService, type PosReceipt } from './pos-receipt.service';
import { parsePosSettings } from './pos-settings.schema';
import { billPdfFilename } from './pos-bill-pdf';

/**
 * The bill as a PDF, from receipts the receipt service makes (the shape of
 * GET /pos/receipts/:orderId and the public bill). Jest cannot load the PDF
 * engine, an ES module, without --experimental-vm-modules, so each bill is
 * rendered by Node itself, through the module the server runs.
 */

const SERVER = join(__dirname, '..', '..');
const RENDER = `
let input = '';
process.stdin.on('data', (chunk) => (input += chunk)).on('end', async () => {
    const { renderBillPdf } = require('./src/pos/pos-bill-pdf.tsx');
    process.stdout.write((await renderBillPdf(JSON.parse(input))).toString('base64'));
});
`;

function render(receipt: PosReceipt): Buffer {
    const out = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', RENDER], {
        cwd: SERVER,
        input: JSON.stringify(receipt),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    if (out.status !== 0) throw new Error(out.stderr || `render exited with ${out.status}`);
    return Buffer.from(out.stdout, 'base64');
}

/**
 * The PDF's text, in page order: the built-in fonts write each run as hex
 * strings in a TJ array. Runs keep their own spaces, and a word can span two
 * (`#` and `M1042`), so they are joined as they are.
 */
function textOf(pdf: Buffer): string {
    const runs: string[] = [];
    for (const stream of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
        let content: string;
        try {
            content = inflateSync(Buffer.from(stream[1], 'latin1')).toString('latin1');
        } catch {
            continue;
        }
        for (const tj of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
            runs.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) => Buffer.from(hex[1], 'hex').toString('latin1')).join(''));
        }
    }
    return runs.join('').replace(/\s+/g, ' ');
}

const d = (v: string | number) => new Prisma.Decimal(v);
const PROFILE = {
    storeName: 'Acme Store', address1: '12 MG Road', address2: '', city: 'Bengaluru', province: 'Karnataka', zip: '560001',
    country: 'India', supportPhone: '+91 80 4000 0000', whatsappPhone: '', supportEmail: '', website: '', logoUrl: '',
};

async function receiptOf(order: Record<string, unknown>, opts: { gstEnabled?: boolean } = {}): Promise<PosReceipt> {
    const prisma: any = {
        order: { findFirst: jest.fn().mockResolvedValue(order) },
        organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme Pvt Ltd', logo: null, gstEnabled: opts.gstEnabled ?? true }) },
        organizationGstin: { findFirst: jest.fn().mockResolvedValue({ gstin: '29AAACA1234A1Z5', address: { address1: 'Reg office' } }) },
    };
    const service = new PosReceiptService(
        prisma,
        { getStoreProfileSettings: jest.fn().mockResolvedValue(PROFILE) } as any,
        { settings: jest.fn().mockResolvedValue(parsePosSettings({ receiptWidth: 80, receiptFooter: 'No exchange after 7 days.' })) } as any,
    );
    return service.receipt('org_1', 'order_1');
}

/** A counter sale of two lines at 5% and 12% GST, paid in cash and UPI, by a known customer. */
const WITH_GST = {
    id: 'order_1', name: '#M1001', createdAt: new Date('2026-10-26T06:30:00Z'), totalPrice: d('3244.00'), taxesIncluded: false,
    metadata: { source: 'offline', pos: { storeId: 'wh_1', roundOff: 0, clientSaleId: 'c1' } },
    posStaff: { name: 'Ravi' },
    dispatchWarehouse: { name: 'MG Road' },
    customer: { firstName: 'Asha', lastName: 'Menon', phone: '+919800000001', gstin: null },
    payments: [
        { method: 'CASH', amount: d('2244'), tendered: d('2500'), reference: null },
        { method: 'UPI', amount: d('1000'), tendered: null, reference: 'UTR42' },
    ],
    lineItems: [
        {
            id: 'li_1', title: 'Linen shirt', variantTitle: 'M', quantity: 2, price: d('1000'), totalDiscount: d('100'), channelTaxAmount: d('95'),
            channelTaxLines: [{ title: 'CGST', rate: 0.025, price: '47.50' }, { title: 'SGST', rate: 0.025, price: '47.50' }],
            variant: { hsnCode: null, product: { hsnCode: '6205' } },
        },
        {
            id: 'li_2', title: 'Cotton kurta', variantTitle: null, quantity: 1, price: d('1115.18'), totalDiscount: d('0'), channelTaxAmount: d('133.82'),
            channelTaxLines: [{ title: 'CGST', rate: 0.06, price: '66.91' }, { title: 'SGST', rate: 0.06, price: '66.91' }],
            variant: { hsnCode: '6211', product: { hsnCode: null } },
        },
    ],
    invoices: [],
};

/** A walk-in with no GST on the bill, rounded off and part paid, at a store with GST switched off. */
const WITHOUT_GST = {
    ...WITH_GST,
    name: '#M1002',
    totalPrice: d('1049.60'),
    metadata: { pos: { storeId: 'default', roundOff: 0.4, clientSaleId: 'c2' } },
    posStaff: null,
    dispatchWarehouse: null,
    customer: null,
    payments: [{ method: 'CASH', amount: d('500'), tendered: null, reference: null }],
    lineItems: [{ id: 'li_3', title: 'Handloom saree', variantTitle: null, quantity: 1, price: d('1049.60'), totalDiscount: d('0'), channelTaxLines: [], channelTaxAmount: d('0'), variant: null }],
};

const isPdf = (pdf: Buffer) => pdf.subarray(0, 5).toString('latin1') === '%PDF-' && pdf.subarray(-8).toString('latin1').includes('%%EOF');

describe('the bill as a PDF', () => {
    it('a sale with GST: the store, the bill, the customer’s name, the lines, the GST summary, the payments and the footer', async () => {
        const receipt = await receiptOf(WITH_GST);
        const pdf = render(receipt);
        expect(isPdf(pdf)).toBe(true);
        expect(pdf.length).toBeGreaterThan(2000);
        const text = textOf(pdf);
        for (const part of [
            'Acme Store',
            '12 MG Road, Bengaluru, Karnataka 560001',
            'Phone +91 80 4000 0000',
            'GSTIN 29AAACA1234A1Z5',
            'RECEIPT',
            '#M1001',
            '26 October 2026',
            'BILLED TO',
            'Asha Menon',
            'Amounts in INR',
            'Linen shirt',
            'HSN 6205',
            'GST 5%',
            '1,995.00',
            'Cotton kurta',
            'GST 12%',
            'Subtotal',
            'CGST',
            'Total',
            '3,244.00',
            'The total includes GST.',
            'GST SUMMARY',
            '1,115.18',
            '66.91',
            'Paid by Cash',
            'Received 2,500.00, change 256.00',
            'Paid by UPI',
            'Reference UTR42',
            'No exchange after 7 days.',
            'Billed by Ravi at MG Road',
            'Thank you for shopping with us.',
        ]) {
            expect([part, text.includes(part)]).toEqual([part, true]);
        }
        // The customer's number stays off a file that is sent and forwarded.
        expect(text).not.toMatch(/9800000001|98000 00001/);
        expect(text).not.toContain('Balance due');
    }, 30_000);

    it('a walk-in sale without GST: no GSTIN, tax or summary; the round-off and the balance due', async () => {
        const receipt = await receiptOf(WITHOUT_GST, { gstEnabled: false });
        expect(receipt.store.gstin).toBeNull();
        const pdf = render(receipt);
        expect(isPdf(pdf)).toBe(true);
        const text = textOf(pdf);
        for (const part of ['Acme Store', 'BILL', '#M1002', 'Handloom saree', 'Round-off', '+0.40', '1,050.00', 'Paid by Cash', '500.00', 'Balance due', '550.00', 'No exchange after 7 days.']) {
            expect([part, text.includes(part)]).toEqual([part, true]);
        }
        for (const absent of ['GSTIN', 'GST SUMMARY', 'CGST', 'BILLED TO', 'The total includes GST.', 'Billed by']) {
            expect([absent, text.includes(absent)]).toEqual([absent, false]);
        }
    }, 30_000);

    it('a sale with a GST invoice prints the invoice’s number, date and place of supply', async () => {
        const invoice = {
            invoiceNumber: 'INV-26-27/000007', invoiceDate: new Date('2026-10-26T00:00:00Z'), placeOfSupply: '29', placeOfSupplyName: 'Karnataka',
            gstType: GstType.CGST_SGST, sellerGstin: '29AAACA9999A1Z5', sellerAddress: null,
            lineItems: [{
                orderLineItemId: 'li_1', hsnCode: '6205', taxableValue: d('1900'), gstRate: d('5'),
                cgstAmount: d('47.50'), sgstAmount: d('47.50'), igstAmount: d('0'), totalAmount: d('1995'),
            }],
        };
        const text = textOf(render(await receiptOf({ ...WITH_GST, lineItems: [WITH_GST.lineItems[0]], totalPrice: d('1995'), invoices: [invoice] })));
        for (const part of ['TAX INVOICE', 'INV-26-27/000007', 'INVOICE NUMBER', 'BILL NUMBER', '#M1001', 'PLACE OF SUPPLY', 'Karnataka', 'Taxable value', 'GSTIN 29AAACA9999A1Z5']) {
            expect([part, text.includes(part)]).toEqual([part, true]);
        }
    }, 30_000);

    it('names the file after the bill, safe as a file name', () => {
        expect(billPdfFilename('#M1042')).toBe('Bill-M1042.pdf');
        expect(billPdfFilename('INV-26-27/000042')).toBe('Bill-INV-26-27-000042.pdf');
        expect(billPdfFilename('A:B*C?')).toBe('Bill-A-B-C.pdf');
    });
});
