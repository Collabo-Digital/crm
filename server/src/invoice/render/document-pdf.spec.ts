import { spawnSync } from 'child_process';
import { join } from 'path';
import * as QRCode from 'qrcode';
import type { DocumentModel } from './document-model';
import { formatAmount, formatMoney } from './money';
import { B2B_ITEMS, DOCUMENT_FIXTURES, type FixtureName, SPEC_VARIANTS, type VariantName } from './pdf/fixtures/documents';
import { PAGE } from './pdf/layout';
import { type PdfPage, readPdfText } from './pdf/pdf-text';

/**
 * The renderer on every sample document in pdf/fixtures. Jest cannot load the
 * PDF engine, an ES module, without --experimental-vm-modules, so the PDFs
 * are rendered by Node itself, in one child process, through the module the
 * server runs. Their text is read back through each font's ToUnicode map.
 */

const SERVER = join(__dirname, '..', '..', '..');
const RENDER = `
const { renderDocumentPdf } = require('./src/invoice/render/document-pdf.tsx');
const { DOCUMENT_FIXTURES, SPEC_VARIANTS } = require('./src/invoice/render/pdf/fixtures/documents.ts');
(async () => {
    const pdfs = {};
    for (const [name, build] of Object.entries({ ...DOCUMENT_FIXTURES, ...SPEC_VARIANTS })) pdfs[name] = (await renderDocumentPdf(build())).toString('base64');
    process.stdout.write(JSON.stringify(pdfs));
})().catch((error) => {
    process.stderr.write(String((error && error.stack) || error));
    process.exit(1);
});
`;

type Rendered = FixtureName | VariantName;
const NAMES = Object.keys(DOCUMENT_FIXTURES) as FixtureName[];
const pdfs = {} as Record<Rendered, Buffer>;
const pages = {} as Record<Rendered, PdfPage[]>;
const model = (name: FixtureName): DocumentModel => DOCUMENT_FIXTURES[name]();

/** Everything drawn, block by block, across pages. */
const flow = (name: Rendered) => pages[name].map((page) => page.flow).join(' ');

function expectIn(text: string, parts: string[]) {
    for (const part of parts) expect([part, text.includes(part)]).toEqual([part, true]);
}
function expectNotIn(text: string, parts: string[]) {
    for (const part of parts) expect([part, text.includes(part)]).toEqual([part, false]);
}
const count = (text: string, part: string) => text.split(part).length - 1;

/** A typical document stays on one page; the long ones break where the design says. */
const PAGE_COUNT: Record<FixtureName, number> = {
    'b2c-intra-paid-modern-hindi': 1,
    'b2c-inter-discount-light-brand': 2,
    'b2b-classic-26-lines-unpaid-qr': 3,
    'union-territory-utgst-cod': 1,
    'bill-of-supply-composition': 1,
    'credit-note-signed': 1,
    'bill-no-gst': 1,
    'cancelled-invoice': 1,
    'long-names': 2,
    'no-logo-no-trade-name': 1,
};

beforeAll(() => {
    const out = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', RENDER], {
        cwd: SERVER,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (out.status !== 0) throw new Error(out.stderr || `render exited with ${out.status}`);
    const rendered = JSON.parse(out.stdout) as Record<Rendered, string>;
    for (const name of [...NAMES, ...(Object.keys(SPEC_VARIANTS) as VariantName[])]) {
        pdfs[name] = Buffer.from(rendered[name], 'base64');
        pages[name] = readPdfText(pdfs[name]);
    }
}, 120_000);

describe('every document', () => {
    it.each(NAMES)('%s: a complete PDF of the expected length, numbered "Page x of y" on every page', (name) => {
        const pdf = pdfs[name];
        expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(pdf.subarray(-8).toString('latin1')).toContain('%%EOF');
        const total = pages[name].length;
        expect(total).toBe(PAGE_COUNT[name]);
        pages[name].forEach((page, i) => {
            expect(count(page.text, 'Page ')).toBe(1);
            // At the right of the footer's last line, clear of the paper's edge.
            const number = page.runs.find((run) => run.text === `Page ${i + 1} of ${total}`)!;
            expect(number.x + number.width).toBeCloseTo(PAGE.width - PAGE.side, 0);
            expect(number.y).toBeGreaterThan(14);
            expect(number.y).toBeLessThan(26);
            expect(page.lines.some((line) => line.endsWith(`Page ${i + 1} of ${total}`))).toBe(true);
        });
    });

    it.each(NAMES)('%s: the title, the copy mark on every page, and the strip on every page after the first', (name) => {
        const m = model(name);
        expect(pages[name][0].text).toContain(m.title);
        const brand = m.seller.tradeName ?? m.seller.legalName;
        pages[name].forEach((page, i) => {
            if (m.copyMark) expect(page.lines[0]).toContain(m.copyMark);
            const strip = `${brand} · ${m.title} ${m.documentNumber} · continued`;
            expect([i + 1, page.flow.includes(strip)]).toEqual([i + 1, i > 0]);
        });
        if (!m.copyMark) expectNotIn(flow(name), ['ORIGINAL FOR RECIPIENT']);
    });

    it.each(NAMES)('%s: the status block in order, the grand total with the currency sign, and the footer on every page', (name) => {
        const m = model(name);
        const status = [m.status.chip?.text, m.status.line, formatMoney(m.status.amount, m.currency), m.status.note].filter(Boolean).join(' ');
        expectIn(pages[name][0].flow, [`${m.title} ${m.subtitle ? `${m.subtitle} ` : ''}${status}`]);
        expectIn(flow(name), [`${m.totals.grandLabel} ${formatMoney(m.totals.grandTotal, m.currency)}`]);
        for (const page of pages[name]) {
            expectIn(page.flow, m.footer.lines);
            if (m.footer.computerGenerated) expectIn(page.flow, [m.footer.computerGenerated]);
        }
        if (!m.footer.computerGenerated) expectNotIn(flow(name), ['computer-generated']);
    });

    it.each(NAMES)('%s: no text runs off the paper or past the side margins', (name) => {
        // The watermark is turned and runs corner to corner by design.
        const runs = pages[name].flatMap((page) => page.runs.filter((run) => run.size < 40));
        const outside = runs.filter((run) => run.x < PAGE.side - 0.5 || run.x + run.width > PAGE.width - PAGE.side + 0.5 || run.y < 12 || run.y > PAGE.height - 12);
        expect(outside.map((run) => run.text)).toEqual([]);
    });

    it.each(NAMES)('%s: every item row exactly once, whole on its line, in order', (name) => {
        const m = model(name);
        // A row's first line runs from its number to its amount; where each is found, by page and line.
        const found = m.lines.map((line) =>
            pages[name].flatMap((page, p) => page.lines.flatMap((text, l) => (text.startsWith(`${line.index} `) && text.endsWith(` ${formatAmount(line.amount)}`) ? [p * 1000 + l] : []))),
        );
        expect(found.map((hits) => hits.length)).toEqual(m.lines.map(() => 1));
        const order = found.map(([at]) => at);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        for (const line of m.lines) if (/^[\x20-\x7e]+$/.test(line.name)) expect(flow(name)).toContain(line.name);
    });
});

describe('the 26-line business invoice over three pages', () => {
    const name = 'b2b-classic-26-lines-unpaid-qr';

    it('lists every line once, in order, across the page break, with the table header repeated where the table continues', () => {
        const skus = B2B_ITEMS.map((item) => item.detail!.split(' · ')[1]);
        const seen = pages[name].flatMap((page) => page.lines.flatMap((line) => line.match(/SJ-\d{4}/g) ?? []));
        expect(seen).toEqual(skus);
        expect(pages[name].map((page) => page.flow.includes('# ITEM & DESCRIPTION HSN QTY RATE DISC. TAXABLE VALUE CGST SGST AMOUNT'))).toEqual([true, true, false]);
        expect(pages[name][0].lines.some((line) => line.startsWith('1 Cotton Kurta'))).toBe(true);
        expect(pages[name][1].lines.some((line) => line.startsWith('26 Linen Shirt'))).toBe(true);
    });

    it('totals the columns on the Total row and keeps the words and totals together', () => {
        expect(pages[name][1].lines).toContain('Total 378 −1,500.00 4,66,920.00 28,033.50 28,033.50 5,22,987.00');
        const page = pages[name].find((p) => p.flow.includes('AMOUNT IN WORDS'))!;
        expectIn(page.flow, [
            'Rupees Five Lakh Twenty-Two Thousand Nine Hundred Eighty-Seven Only',
            'Item value (before discount) 4,68,420.00',
            'Less: discount −1,500.00',
            'Taxable value 4,66,920.00',
            'CGST 28,033.50',
            'SGST 28,033.50',
            'Grand total ₹5,22,987.00',
            'Amount paid 0.00',
            'Balance due ₹5,22,987.00',
        ]);
        expect(pages[name][1].lines).toContain('6211 18% 2,51,700.00 22,653.00 22,653.00 45,306.00');
    });

    it('asks for the balance with a UPI QR, and signs on the last page', () => {
        const pay = pages[name].find((page) => page.flow.includes('PAY BY UPI'))!;
        expectIn(pay.flow, ['Scan to pay ₹5,22,987.00', 'UPI ID saanjh@okaxis']);
        const last = pages[name][2];
        expectIn(last.flow, ['For Saanjh Apparel Private Limited', 'Authorised Signatory', 'Meera Rao, Director']);
        expectIn(last.flow, ['1. Payment is due within 15 days of the invoice date.', '3. Goods once delivered are the buyer’s responsibility.']);
        // The logo, the QR and the signature, each drawn once.
        expect(pages[name].reduce((sum, page) => sum + page.images.length, 0)).toBe(3);
        expect(pay.images.length).toBeGreaterThanOrEqual(1);
        expect(last.images.length).toBeGreaterThanOrEqual(1);
    });

    it('prints both parties with their GSTINs, the ship-to beside the bill-to', () => {
        expectIn(pages[name][0].text, ['BILL TO SHIP TO', 'Kavya Retail LLP Kavya Retail LLP (Whitefield store)', 'GSTIN 29AAAFK0000A1Z5 GSTIN 29AAAFK0000A1Z5']);
    });
});

describe('tax columns follow the tax heads', () => {
    it('intra-state: CGST and SGST, each amount with its rate beneath', () => {
        const text = pages['b2c-intra-paid-modern-hindi'][0].text;
        expectIn(text, ['VALUE CGST SGST AMOUNT', 'Indigo / M · SJ-KUR-IND-M @2.5% @2.5%', 'Rust · SJ-DUP-RST @9% @9%', 'CGST 291.79', 'SGST 291.78']);
        expectNotIn(text, ['IGST', 'UTGST']);
    });

    it('inter-state: IGST alone', () => {
        const text = flow('b2c-inter-discount-light-brand');
        expectIn(text, ['TAXABLE VALUE IGST AMOUNT', 'IGST 402.68', 'HSN GST RATE TAXABLE VALUE IGST TOTAL TAX']);
        expectNotIn(text, ['CGST', 'SGST']);
    });

    it('a Union territory seller: UTGST where SGST would be', () => {
        const text = pages['union-territory-utgst-cod'][0].text;
        expectIn(text, ['VALUE CGST UTGST AMOUNT', 'UTGST 78.08', 'HSN GST RATE TAXABLE VALUE CGST UTGST TOTAL TAX']);
        expectNotIn(text, ['SGST', 'IGST']);
    });

    it('a Bill of Supply: no tax columns, totals or summary, and the composition line word for word', () => {
        const text = flow('bill-of-supply-composition');
        expectIn(text, ['BILL OF SUPPLY Composition taxable person, not eligible to collect tax on supplies', '# ITEM & DESCRIPTION HSN QTY PRICE DISC. AMOUNT']);
        expectNotIn(text, ['CGST', 'SGST', 'UTGST', 'IGST', 'TAXABLE', 'Taxable value', 'TAX SUMMARY', '@']);
        expectIn(text, ['This is a computer-generated bill and does not need a signature.']);
    });

    it('a BILL: no GSTIN, copy mark, HSN or tax; the round-off to the net payable', () => {
        const text = flow('bill-no-gst');
        expectIn(text, ['# ITEM & DESCRIPTION QTY PRICE AMOUNT', 'Item value 549.25', 'Round off −0.25', 'Net payable ₹549.00', 'Cash · Received ₹500.00 · Change ₹93.00 · ₹407.00']);
        expectNotIn(text, ['GSTIN', 'ORIGINAL FOR RECIPIENT', 'HSN', 'GST', 'TAXABLE']);
    });
});

describe('documents and their states', () => {
    it('a credit note: its reference and reason, "Amount credited", and a signatory instead of the computer-generated note', () => {
        const text = flow('credit-note-signed');
        expectIn(text, [
            'CREDIT NOTE Against INV-26-27/000124 ₹1,349.00',
            'Against invoice INV-26-27/000124 dated 27 Oct 2026 Reason: Returned unworn, wrong size',
            'Amount credited ₹1,349.00',
            'For Saanjh Apparel Private Limited',
            'Authorised Signatory',
        ]);
        expect(pages['credit-note-signed'][0].images.length).toBe(2);
    });

    it('a cancelled invoice: the CANCELLED chip, and the watermark across every page', () => {
        const text = pages['cancelled-invoice'][0].text;
        expectIn(text, ['Cancelled on 28 Oct 2026']);
        expect(count(text, 'CANCELLED')).toBe(2);
        // The chip on the first page, and the watermark on each.
        const counts = pages['cancelled-over-several-pages'].map((page) => count(page.text, 'CANCELLED'));
        expect(counts.length).toBeGreaterThan(1);
        expect(counts).toEqual([2, ...counts.slice(1).map(() => 1)]);
        expectNotIn(flow('b2c-intra-paid-modern-hindi'), ['CANCELLED']);
    });

    it.each(['notes-longer-than-a-page', 'terms-longer-than-a-page'] as const)(
        '%s: a block taller than a page flows on, every page whole with its footer and number, nothing lost or off the paper',
        (name) => {
            const total = pages[name].length;
            expect(total).toBeGreaterThan(1);
            pages[name].forEach((page, i) => {
                expectIn(page.flow, ['Registered office:', `Page ${i + 1} of ${total}`]);
                const outside = page.runs.filter((run) => run.size < 40 && (run.y < 12 || run.y > PAGE.height - 12));
                expect(outside.map((run) => run.text)).toEqual([]);
            });
            const last = name === 'notes-longer-than-a-page' ? 'SN-2026-100212' : '90. Term number 90.';
            expect(count(flow(name), last)).toBe(1);
            // Nothing squeezed: the table header and the first row still read as one line each.
            expect(pages[name][0].lines.some((line) => line.startsWith('# ITEM & DESCRIPTION'))).toBe(true);
        },
    );

    it('a currency other than the rupee prints its code wherever the rupee sign would be', () => {
        expectIn(flow('bill-in-usd'), ['PAID Paid at the counter USD 549.00', 'Net payable USD 549.00']);
        expectNotIn(flow('bill-in-usd'), ['₹549.00']);
    });

    it('cash on delivery: the chip and the amount due, with no UPI QR', () => {
        const page = pages['union-territory-utgst-cod'][0];
        expectIn(page.flow, ['CASH ON DELIVERY Collect on delivery ₹1,733.00', 'PAYMENT DUE ₹1,733.00', 'Balance due ₹1,733.00']);
        expectNotIn(page.flow, ['Scan to pay']);
        expect(page.images).toEqual([]);
    });

    it.each(['b2b-classic-26-lines-unpaid-qr', 'long-names'] as const)('%s: the QR encodes the payment link exactly, module for module', (name) => {
        const payment = model(name).payment;
        if (payment?.kind !== 'due' || !payment.upiUri) throw new Error('fixture has no UPI link');
        const qr = QRCode.create(payment.upiUri, { errorCorrectionLevel: 'M' });
        // One module of quiet zone and 6 pixels a module, as the renderer asks of the encoder.
        const side = (qr.modules.size + 2) * 6;
        const image = pages[name].flatMap((page) => page.images).find((img) => img.width === side && img.height === side)!;
        expect(image.filter).toBe('FlateDecode');
        const channels = image.colorSpace === 'DeviceRGB' ? 3 : 1;
        const dark = (row: number, col: number) => image.data[(((row + 1) * 6 + 3) * side + (col + 1) * 6 + 3) * channels] < 128;
        let wrong = 0;
        for (let row = 0; row < qr.modules.size; row++) for (let col = 0; col < qr.modules.size; col++) if (dark(row, col) !== !!qr.modules.get(row, col)) wrong++;
        expect(wrong).toBe(0);
    });

    it('the Rule 46(s) declaration in full where the model carries it, and nowhere else', () => {
        const declaration = model('union-territory-utgst-cod').declaration!;
        for (const name of NAMES) expect([name, flow(name).includes(declaration)]).toEqual([name, !!model(name).declaration]);
    });

    it('a paid invoice: the PAID chip and the payment received', () => {
        expectIn(pages['b2c-intra-paid-modern-hindi'][0].flow, ['PAID Paid on 25 Oct 2026 ₹5,647.00 UPI via Razorpay', 'PAYMENT RECEIVED UPI via Razorpay · Txn ID pay_SAMPLE7Hx2 · 25 Oct 2026, 18:42 · ₹5,647.00']);
    });
});

describe('text and amounts as formatted', () => {
    it('amounts with Indian grouping, two decimals and a true minus sign', () => {
        const text = flow('b2c-intra-paid-modern-hindi');
        expectIn(text, ['1,427.62', '−142.86', '5,206.29', '₹5,647.00', 'Rupees Five Thousand Six Hundred Forty-Seven Only']);
        expectNotIn(text, ['-142.86', 'INR']);
        expectIn(flow('long-names'), ['1,10,75,000.00', '1,16,28,750.00', 'Grand total ₹1,17,55,170.00', 'Scan to pay ₹67,55,170.00', 'Advance of ₹50,00,000.00 received']);
    });

    it('a figure in the crores never wraps: each row reads whole on one line', () => {
        const lines = pages['long-names'][0].lines;
        expect(lines.find((line) => line.startsWith('1 Kanchipuram'))).toMatch(/ 5007 600 PCS 18,500\.00 −25,000\.00 1,10,75,000\.00 2,76,875\.00 2,76,875\.00 1,16,28,750\.00$/);
        expect(lines).toContain('Total 652 −25,000.00 1,11,95,400.00 2,79,885.00 2,79,885.00 1,17,55,170.00');
    });

    it('a Hindi product name prints in Noto Sans Devanagari', () => {
        const name = model('b2c-intra-paid-modern-hindi').lines[1].name;
        const row = pages['b2c-intra-paid-modern-hindi'][0].lines.find((line) => line.startsWith('2 '))!;
        // Read back in drawing order, so compared as characters.
        const devanagari = (text: string) => [...text].filter((c) => /[ऀ-ॿ]/.test(c)).sort();
        expect(devanagari(row)).toEqual(devanagari(name));
        expect(pdfs['b2c-intra-paid-modern-hindi'].toString('latin1')).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari-Bold/);
    });

    it('long names wrap whole, over as many lines as they need', () => {
        const m = model('long-names');
        expectIn(flow('long-names'), [
            m.seller.tradeName!,
            m.seller.legalName,
            m.seller.dispatchFrom!,
            ...m.parties.map((party) => party.name),
            ...m.lines.map((line) => line.name),
            m.signatory!.forName,
            'PAN AAAAV1234Q · CIN U17111TN1998PTC041234 · Udyam Reg. No. UDYAM-TN-03-0045678 · IEC AAAAV1234Q · LUT AD330326001234X · Handloom Mark No. HLM/TN/2019/00417',
            '+91 44 2722 0000 · +91 94440 00000 · customercare@venkateshwarahandlooms.example · venkateshwarahandlooms.example',
        ]);
        // The signatory lands on the last page, with the notes and the brand's closing line.
        expectIn(pages['long-names'][1].flow, ['Authorised Signatory', 'K. Raghunathan, Secretary', 'NOTES', m.footer.note!]);
        // A link and a SKU too long for their column break across lines, hyphenated, instead of running over the next column.
        expectIn(flow('long-names'), ['with your invoice number, or use https://', 'VH-DHT-']);
        expect(flow('long-names')).not.toContain('VH-DHT-ANGAVASTRAM-4M-OFFWHITE-GOLD-2026');
    });

    it('no logo and no trading name: the legal name is the wordmark, printed once', () => {
        const page = pages['no-logo-no-trade-name'][0];
        expect(count(page.flow, 'Meenakshi Textiles')).toBe(1);
        expect(page.images).toEqual([]);
        expectNotIn(page.flow, ['AMOUNT IN WORDS']);
    });

    it('logos embed as drawn: PNG beside the trading name, JPEG on its own', () => {
        expect(pages['b2c-intra-paid-modern-hindi'][0].images.length).toBe(1);
        expect(pages['b2c-inter-discount-light-brand'][0].images.map((image) => image.filter)).toEqual(['DCTDecode']);
        expect(pdfs['b2c-inter-discount-light-brand'].toString('latin1')).toContain('/DCTDecode');
        expectIn(pages['b2c-intra-paid-modern-hindi'][0].flow, ['Saanjh Saanjh Apparel Private Limited']);
        expectNotIn(pages['b2c-inter-discount-light-brand'][0].flow, ['Mitti & Co.']);
    });
});
