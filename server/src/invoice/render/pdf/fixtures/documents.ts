import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocAmount, DocImage, DocLine, DocSeller, DocTaxHeads, DocTaxSummary, DocTotals, DocumentModel } from '../../document-model';

/**
 * Sample documents for the renderer's specs and for looking at the output:
 * every kind and case in invoice-design.md 4.6. All data is invented. The
 * figures are worked out here the way a builder would, so every column,
 * total and summary adds up.
 */

const image = (file: string, format: DocImage['format']): DocImage => ({ data: readFileSync(join(__dirname, file)), format });

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Item {
    name: string;
    detail?: string;
    hsn?: string;
    quantity: number;
    unit: string;
    /** Per unit: inclusive of GST for `inclusive`, before GST for `exclusive`. */
    price: number;
    /** Off the line, on the same basis as `price`. */
    discount?: number;
    gst: number;
}

/** A line split into the heads a document prints. */
function taxed(base: Omit<DocLine, 'cgst' | 'sgst' | 'igst' | 'amount'>, gst: number, tax: number, heads: DocTaxHeads): DocLine {
    if (heads === 'IGST') return { ...base, cgst: null, sgst: null, igst: { amount: tax, rate: gst }, amount: r2(base.taxable + tax) };
    if (heads) {
        const cgst = r2(tax / 2);
        return { ...base, cgst: { amount: cgst, rate: gst / 2 }, sgst: { amount: r2(tax - cgst), rate: gst / 2 }, igst: null, amount: r2(base.taxable + tax) };
    }
    return { ...base, cgst: null, sgst: null, igst: null, amount: base.taxable };
}

/** D2C prices include GST: the rate and taxable value are backed out, and the tax is the difference. */
function inclusive(items: Item[], heads: DocTaxHeads): DocLine[] {
    return items.map((item, i) => {
        const factor = 1 + item.gst / 100;
        const charged = r2(item.price * item.quantity - (item.discount ?? 0));
        const rate = r2(item.price / factor);
        const taxable = r2(charged / factor);
        // Backing out leaves a paisa between rate × quantity and the taxable value; only a real discount is one.
        const discount = item.discount ? r2(rate * item.quantity - taxable) : 0;
        const base = { index: i + 1, name: item.name, detail: item.detail ?? null, hsn: item.hsn ?? null, quantity: `${item.quantity} ${item.unit}`, rate, discount, taxable };
        return taxed(base, item.gst, r2(charged - taxable), heads);
    });
}

/** Business prices are before GST. With no tax heads, the price is the whole amount. */
function exclusive(items: Item[], heads: DocTaxHeads): DocLine[] {
    return items.map((item, i) => {
        const taxable = r2(item.price * item.quantity - (item.discount ?? 0));
        const base = { index: i + 1, name: item.name, detail: item.detail ?? null, hsn: item.hsn ?? null, quantity: `${item.quantity} ${item.unit}`, rate: item.price, discount: item.discount ?? 0, taxable };
        return taxed(base, item.gst, heads ? r2((taxable * item.gst) / 100) : 0, heads);
    });
}

const add = (values: number[]) => r2(values.reduce((a, b) => a + b, 0));

function totalsOf(
    lines: DocLine[],
    opts: { charges?: DocAmount[]; roundTo?: boolean; grandLabel?: string; paid?: number | null } = {},
): DocTotals {
    const units = new Set(lines.map((line) => line.quantity.split(' ')[1]));
    const charges = opts.charges ?? [];
    const exact = add([...lines.map((line) => line.amount), ...charges.map((charge) => charge.amount)]);
    const grandTotal = opts.roundTo ? Math.round(exact) : exact;
    const paid = opts.paid ?? null;
    return {
        quantity: units.size === 1 ? add(lines.map((line) => Number(line.quantity.split(' ')[0]))) : null,
        itemValue: add(lines.map((line) => r2(line.rate * Number(line.quantity.split(' ')[0])))),
        discount: add(lines.map((line) => line.discount)),
        taxable: add(lines.map((line) => line.taxable)),
        cgst: add(lines.map((line) => line.cgst?.amount ?? 0)),
        sgst: add(lines.map((line) => line.sgst?.amount ?? 0)),
        igst: add(lines.map((line) => line.igst?.amount ?? 0)),
        charges,
        roundOff: r2(grandTotal - exact),
        grandLabel: opts.grandLabel ?? 'Grand total',
        grandTotal,
        paid,
        balanceDue: paid === null ? null : r2(grandTotal - paid),
    };
}

/** One row per HSN and rate, sorted by HSN then rate. */
function summaryOf(lines: DocLine[]): DocTaxSummary {
    const groups = new Map<string, DocTaxSummary['rows'][number]>();
    for (const line of lines) {
        const rate = line.igst ? line.igst.rate : (line.cgst?.rate ?? 0) * 2;
        const key = `${line.hsn}|${rate}`;
        const row = groups.get(key) ?? { hsn: line.hsn ?? '', rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0 };
        row.taxable = r2(row.taxable + line.taxable);
        row.cgst = r2(row.cgst + (line.cgst?.amount ?? 0));
        row.sgst = r2(row.sgst + (line.sgst?.amount ?? 0));
        row.igst = r2(row.igst + (line.igst?.amount ?? 0));
        row.totalTax = r2(row.cgst + row.sgst + row.igst);
        groups.set(key, row);
    }
    const rows = [...groups.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
    const total = (key: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'totalTax') => add(rows.map((row) => row[key]));
    return { rows, total: { taxable: total('taxable'), cgst: total('cgst'), sgst: total('sgst'), igst: total('igst'), totalTax: total('totalTax') } };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n: number) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
const three = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');
function indian(n: number): string {
    const parts: string[] = [];
    if (n >= 1e7) parts.push(`${indian(Math.floor(n / 1e7))} Crore`);
    if (Math.floor(n / 1e5) % 100) parts.push(`${two(Math.floor(n / 1e5) % 100)} Lakh`);
    if (Math.floor(n / 1e3) % 100) parts.push(`${two(Math.floor(n / 1e3) % 100)} Thousand`);
    if (n % 1e3) parts.push(three(n % 1e3));
    return parts.join(' ');
}
/** Sample wording only; the builders have their own. */
function words(amount: number): string {
    const rupees = Math.floor(amount + 1e-9);
    const paise = Math.round((amount - rupees) * 100);
    return `Rupees ${indian(rupees) || 'Zero'}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

const money = (n: number) => `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;

const RULE_46S =
    'I/We hereby declare that though our aggregate turnover in any preceding financial year from 2017-18 onwards is more than the aggregate turnover notified under sub-rule (4) of rule 48, we are not required to prepare an invoice in terms of the provisions of the said sub-rule.';
const COMPOSITION = 'Composition taxable person, not eligible to collect tax on supplies';
const COMPUTER_INVOICE = 'This is a computer-generated invoice and does not need a signature.';
const COMPUTER_BILL = 'This is a computer-generated bill and does not need a signature.';

const SAANJH: DocSeller = {
    tradeName: 'Saanjh',
    legalName: 'Saanjh Apparel Private Limited',
    addressLines: ['No. 12, 100 Feet Road, Indiranagar', 'Bengaluru, Karnataka 560038'],
    contactLine: '+91 80 4000 0000 · care@saanjh.example · saanjh.example',
    gstin: '29ABCDE1234F1Z5',
    state: 'Karnataka (29)',
    ids: [
        { label: 'PAN', value: 'ABCDE1234F' },
        { label: 'CIN', value: 'U18101KA2021PTC000000' },
    ],
    dispatchFrom: null,
    logo: image('logo-mark.png', 'png'),
};
const SAANJH_FOOTER = [
    'Registered office: No. 12, 100 Feet Road, Indiranagar, Bengaluru 560038 · CIN U18101KA2021PTC000000',
    'Questions about this order? WhatsApp +91 90000 00000 · care@saanjh.example',
];
const SAANJH_SIGNATORY = { forName: 'For Saanjh Apparel Private Limited', image: image('signature.png', 'png'), name: 'Meera Rao', designation: 'Director' };
const ASHA = { heading: 'BILL TO / SHIP TO', name: 'Asha Menon', lines: ['Flat 4B, Palm Grove Apartments', '27th Main Road, HSR Layout, Bengaluru 560102'], state: 'Karnataka (29)', gstin: null };

/** Modern, brand colour and logo; intra-state B2C, paid online; one product named in Hindi. */
function b2cIntraPaid(): DocumentModel {
    const heads = 'CGST_SGST';
    const lines = inclusive(
        [
            { name: 'Handblock Cotton Kurta', detail: 'Indigo / M · SJ-KUR-IND-M', hsn: '6211', quantity: 1, unit: 'PCS', price: 1499, discount: 150, gst: 5 },
            { name: 'बनारसी सिल्क दुपट्टा', detail: 'Rust · SJ-DUP-RST', hsn: '6214', quantity: 1, unit: 'PCS', price: 2999, gst: 18 },
            { name: 'Linen Palazzo Pants', detail: 'Beige / M · SJ-PLZ-BEI-M', hsn: '6204', quantity: 1, unit: 'PCS', price: 1299, gst: 5 },
        ],
        heads,
    );
    const totals = totalsOf(lines);
    return {
        kind: 'TAX_INVOICE',
        theme: 'modern',
        brandColor: '#0F766E',
        documentNumber: 'INV-26-27/000124',
        title: 'TAX INVOICE',
        subtitle: null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: SAANJH,
        status: { chip: { text: 'PAID', tone: 'paid' }, line: 'Paid on 25 Oct 2026', amount: totals.grandTotal, note: 'UPI via Razorpay' },
        details: [
            { label: 'Invoice No.', value: 'INV-26-27/000124' },
            { label: 'Invoice date', value: '27 Oct 2026' },
            { label: 'Order No.', value: '#1042' },
            { label: 'Order date', value: '25 Oct 2026' },
            { label: 'Payment', value: 'Prepaid (UPI)' },
            { label: 'Place of supply', value: 'Karnataka (29)' },
            { label: 'Supply type', value: 'Intra-state' },
            { label: 'Reverse charge', value: 'No' },
            { label: 'Courier', value: 'Delhivery' },
            { label: 'AWB', value: '1490000000000' },
        ],
        reference: [],
        parties: [ASHA],
        taxHeads: heads,
        showHsn: true,
        showDiscount: true,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: summaryOf(lines),
        payment: { kind: 'received', lines: [`UPI via Razorpay · Txn ID pay_SAMPLE7Hx2 · 25 Oct 2026, 18:42 · ${money(totals.grandTotal)}`] },
        terms: [],
        returns: 'Returns and exchanges within 15 days of delivery for unworn items with tags. https://saanjh.example/returns',
        declaration: null,
        notes: null,
        signatory: null,
        footer: { lines: SAANJH_FOOTER, computerGenerated: COMPUTER_INVOICE, note: 'Thank you for shopping with us.' },
        cancelled: null,
        currency: 'INR',
    };
}

/** A light brand colour (kept off text) and a wide JPEG logo; inter-state at 5% and 18%, discounts, untaxed shipping, the Rule 46(s) declaration. */
function b2cInterDiscount(): DocumentModel {
    const heads = 'IGST';
    const lines = inclusive(
        [
            { name: 'Hand-painted Ceramic Mug Set of 4', detail: 'Indigo Bloom · MC-MUG-IB4', hsn: '6912', quantity: 2, unit: 'SET', price: 1299, discount: 260, gst: 5 },
            { name: 'Terracotta Planter, Large', detail: 'Natural · MC-PLT-L', hsn: '6914', quantity: 1, unit: 'PCS', price: 899, gst: 5 },
            { name: 'Brass Diya Pair', detail: 'Antique finish · MC-DIY-BR2', hsn: '7418', quantity: 1, unit: 'PRS', price: 1499, discount: 150, gst: 18 },
            { name: 'Jute Table Runner', detail: 'Natural · MC-RUN-JT', hsn: '6304', quantity: 2, unit: 'PCS', price: 449, gst: 5 },
        ],
        heads,
    );
    const totals = totalsOf(lines, { charges: [{ label: 'Shipping (not taxed)', amount: 99 }] });
    return {
        kind: 'TAX_INVOICE',
        theme: 'modern',
        brandColor: '#F59E0B',
        documentNumber: 'INV-26-27/000131',
        title: 'TAX INVOICE',
        subtitle: null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: {
            tradeName: 'Mitti & Co.',
            legalName: 'Mitti Crafts LLP',
            addressLines: ['B-14, Industrial Area, Sitapura', 'Jaipur, Rajasthan 302022'],
            contactLine: '+91 141 400 0000 · hello@mitti.example · mitti.example',
            gstin: '08AAKFM1234C1ZQ',
            state: 'Rajasthan (08)',
            ids: [
                { label: 'PAN', value: 'AAKFM1234C' },
                { label: 'Udyam Reg. No.', value: 'UDYAM-RJ-17-0012345' },
            ],
            dispatchFrom: null,
            logo: image('logo-wordmark.jpg', 'jpg'),
        },
        status: { chip: { text: 'PAID', tone: 'paid' }, line: 'Paid on 24 Oct 2026', amount: totals.grandTotal, note: 'Card via Razorpay' },
        details: [
            { label: 'Invoice No.', value: 'INV-26-27/000131' },
            { label: 'Invoice date', value: '26 Oct 2026' },
            { label: 'Order No.', value: '#2207' },
            { label: 'Order date', value: '24 Oct 2026' },
            { label: 'Payment', value: 'Prepaid (card)' },
            { label: 'Place of supply', value: 'Tamil Nadu (33)' },
            { label: 'Supply type', value: 'Inter-state (IGST)' },
            { label: 'Reverse charge', value: 'No' },
        ],
        reference: [],
        parties: [
            { heading: 'BILL TO', name: 'Rohan Iyer', lines: ['12, Second Cross Street, Besant Nagar', 'Chennai 600090'], state: 'Tamil Nadu (33)', gstin: null },
            { heading: 'SHIP TO', name: 'Rohan Iyer (office)', lines: ['Level 5, Olympia Tech Park, Guindy', 'Chennai 600032'], state: 'Tamil Nadu (33)', gstin: null },
        ],
        taxHeads: heads,
        showHsn: true,
        showDiscount: true,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: summaryOf(lines),
        payment: { kind: 'received', lines: [`Card via Razorpay · Txn ID pay_SAMPLE91Kq · 24 Oct 2026, 21:07 · ${money(totals.grandTotal)}`] },
        terms: [],
        returns: 'Damaged in transit? Write to us within 48 hours of delivery with a photo and we will replace it. https://mitti.example/returns',
        declaration: RULE_46S,
        notes: null,
        signatory: null,
        footer: { lines: ['Questions about this order? WhatsApp +91 94140 00000 · hello@mitti.example'], computerGenerated: COMPUTER_INVOICE, note: 'Made by hand in Jaipur. Thank you for supporting our potters.' },
        cancelled: null,
        currency: 'INR',
    };
}

const NAMES = ['Cotton Kurta', 'Linen Shirt', 'Chanderi Kurta Set', 'Palazzo Pants', 'Cotton Dupatta', 'Printed Saree', 'Kids Kurta Set', 'Nehru Jacket'];
const COLOURS = ['Indigo', 'Rust', 'Beige', 'Olive', 'Mustard', 'Ivory', 'Teal'];

/** The 26 lines of the B2B invoice: two lines each, unique SKUs SJ-1000 to SJ-1175. */
export const B2B_ITEMS: Item[] = Array.from({ length: 26 }, (_, i) => {
    const name = NAMES[i % NAMES.length];
    const big = name === 'Printed Saree' || name === 'Chanderi Kurta Set';
    const price = big ? 2650 + (i % 3) * 150 : 520 + (i % 5) * 110;
    return {
        name,
        detail: `${COLOURS[i % COLOURS.length]} / S–XL · SJ-${1000 + i * 7}`,
        hsn: big ? '6211' : ['6211', '6205', '6204', '6214'][i % 4],
        quantity: 6 + (i % 4) * 6,
        unit: 'PCS',
        price,
        discount: i % 6 === 0 ? 300 : 0,
        gst: price > 2500 ? 18 : 5,
    };
});

/** Classic, a business buyer with a separate ship-to, 26 lines over three pages, unpaid with a UPI QR, signed. */
function b2bClassic(): DocumentModel {
    const heads = 'CGST_SGST';
    const lines = exclusive(B2B_ITEMS, heads);
    const totals = totalsOf(lines, { paid: 0 });
    const amount = totals.balanceDue!;
    return {
        kind: 'TAX_INVOICE',
        theme: 'classic',
        brandColor: '#0F766E',
        documentNumber: 'INV-26-27/000125',
        title: 'TAX INVOICE',
        subtitle: null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: SAANJH,
        status: { chip: { text: 'UNPAID', tone: 'due' }, line: 'Due by 11 Nov 2026', amount, note: 'Credit terms: 15 days' },
        details: [
            { label: 'Invoice No.', value: 'INV-26-27/000125' },
            { label: 'Invoice date', value: '27 Oct 2026' },
            { label: 'Order No.', value: '#1051' },
            { label: 'Payment', value: 'Unpaid' },
            { label: 'Place of supply', value: 'Karnataka (29)' },
            { label: 'Supply type', value: 'Intra-state' },
            { label: 'Reverse charge', value: 'No' },
        ],
        reference: [],
        parties: [
            { heading: 'BILL TO', name: 'Kavya Retail LLP', lines: ['45, Commercial Street', 'Bengaluru 560001'], state: 'Karnataka (29)', gstin: '29AAAFK0000A1Z5' },
            { heading: 'SHIP TO', name: 'Kavya Retail LLP (Whitefield store)', lines: ['Unit 12, Phoenix Marketcity, Whitefield Road', 'Bengaluru 560048'], state: 'Karnataka (29)', gstin: '29AAAFK0000A1Z5' },
        ],
        taxHeads: heads,
        showHsn: true,
        showDiscount: true,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: summaryOf(lines),
        payment: {
            kind: 'due',
            amount,
            upiUri: `upi://pay?pa=saanjh%40okaxis&pn=Saanjh&am=${amount.toFixed(2)}&cu=INR&tn=INV-26-27%2F000125`,
            upiId: 'saanjh@okaxis',
        },
        terms: ['Payment is due within 15 days of the invoice date.', 'Interest at 18% a year applies to amounts overdue.', 'Goods once delivered are the buyer’s responsibility.'],
        returns: null,
        declaration: null,
        notes: null,
        signatory: SAANJH_SIGNATORY,
        footer: { lines: SAANJH_FOOTER, computerGenerated: null, note: 'Thank you for your business.' },
        cancelled: null,
        currency: 'INR',
    };
}

/** A seller in a Union territory without a legislature: CGST and UTGST. No logo, no brand colour; cash on delivery, the Rule 46(s) declaration. */
function unionTerritory(): DocumentModel {
    const heads = 'CGST_UTGST';
    const lines = inclusive(
        [
            { name: 'Cold-pressed Mustard Oil, 1 L', detail: 'DO-OIL-MUS-1L', hsn: '1514', quantity: 2, unit: 'BTL', price: 289, gst: 5 },
            { name: 'Multigrain Atta, 5 kg', detail: 'DO-ATT-MG-5', hsn: '1102', quantity: 1, unit: 'BAG', price: 395, gst: 5 },
            { name: 'Dark Chocolate with Jaggery, 100 g', detail: 'DO-CHO-DJ-100', hsn: '1806', quantity: 4, unit: 'PCS', price: 180, gst: 18 },
        ],
        heads,
    );
    const totals = totalsOf(lines, { paid: 0, charges: [{ label: 'Cash on delivery fee (not taxed)', amount: 40 }] });
    return {
        kind: 'TAX_INVOICE',
        theme: 'modern',
        brandColor: null,
        documentNumber: 'INV-26-27/000088',
        title: 'TAX INVOICE',
        subtitle: null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: {
            tradeName: 'Doaba Organics',
            legalName: 'Doaba Organics Private Limited',
            addressLines: ['SCO 112, Sector 17-C', 'Chandigarh 160017'],
            contactLine: '+91 172 400 0000 · orders@doaba.example',
            gstin: '04AAICD1234E1Z2',
            state: 'Chandigarh (04)',
            ids: [
                { label: 'PAN', value: 'AAICD1234E' },
                { label: 'FSSAI Lic. No.', value: '13023999000123' },
            ],
            dispatchFrom: null,
            logo: null,
        },
        status: { chip: { text: 'CASH ON DELIVERY', tone: 'due' }, line: 'Collect on delivery', amount: totals.balanceDue!, note: null },
        details: [
            { label: 'Invoice No.', value: 'INV-26-27/000088' },
            { label: 'Invoice date', value: '27 Oct 2026' },
            { label: 'Order No.', value: '#3310' },
            { label: 'Payment', value: 'Cash on delivery' },
            { label: 'Place of supply', value: 'Chandigarh (04)' },
            { label: 'Supply type', value: 'Intra-state' },
            { label: 'Reverse charge', value: 'No' },
            { label: 'Courier', value: 'Blue Dart' },
            { label: 'AWB', value: '81234567890' },
        ],
        reference: [],
        parties: [{ heading: 'BILL TO / SHIP TO', name: 'Gurpreet Kaur', lines: ['House 2214, Sector 35-C', 'Chandigarh 160022'], state: 'Chandigarh (04)', gstin: null }],
        taxHeads: heads,
        showHsn: true,
        showDiscount: false,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: summaryOf(lines),
        payment: { kind: 'due', amount: totals.balanceDue!, upiUri: null, upiId: 'doaba@okhdfc' },
        terms: [],
        returns: 'Unopened packs can be returned within 7 days of delivery.',
        declaration: RULE_46S,
        notes: null,
        signatory: null,
        footer: { lines: ['Questions about this order? WhatsApp +91 98720 00000 · orders@doaba.example'], computerGenerated: COMPUTER_INVOICE, note: null },
        cancelled: null,
        currency: 'INR',
    };
}

/** A composition seller's Bill of Supply: the Rule 5(1)(f) line, no tax columns, a walk-in at the counter. */
function billOfSupply(): DocumentModel {
    const lines = exclusive(
        [
            { name: 'Ilkal Cotton Saree', detail: 'Maroon / Gold border · KH-ILK-MR', hsn: '5208', quantity: 1, unit: 'PCS', price: 1850, discount: 100, gst: 0 },
            { name: 'Handloom Cotton Towel, pack of 2', detail: 'White · KH-TWL-W2', hsn: '6302', quantity: 2, unit: 'PAC', price: 449, gst: 0 },
        ],
        null,
    );
    const totals = totalsOf(lines);
    return {
        kind: 'BILL_OF_SUPPLY',
        theme: 'modern',
        brandColor: '#9D174D',
        documentNumber: 'INV-26-27/000041',
        title: 'BILL OF SUPPLY',
        subtitle: COMPOSITION,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: {
            tradeName: 'Kumar Handlooms',
            legalName: 'Ravi Kumar',
            addressLines: ['21, Avenue Road', 'Bengaluru, Karnataka 560002'],
            contactLine: '+91 98450 00000 · kumarhandlooms.example',
            gstin: '29ABCPK1234L1Z3',
            state: 'Karnataka (29)',
            ids: [{ label: 'PAN', value: 'ABCPK1234L' }],
            dispatchFrom: null,
            logo: null,
        },
        status: { chip: { text: 'PAID', tone: 'paid' }, line: 'Paid at the counter', amount: totals.grandTotal, note: 'Cash' },
        details: [
            { label: 'Invoice No.', value: 'INV-26-27/000041' },
            { label: 'Invoice date', value: '27 Oct 2026' },
            { label: 'Order No.', value: '#M1044' },
            { label: 'Payment', value: 'Cash' },
            { label: 'Place of supply', value: 'Karnataka (29)' },
        ],
        reference: [],
        parties: [{ heading: 'BILL TO', name: 'Walk-in customer', lines: [], state: 'Karnataka (29)', gstin: null }],
        taxHeads: null,
        showHsn: true,
        showDiscount: true,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: null,
        payment: { kind: 'received', lines: [`Cash · 27 Oct 2026, 16:10 · ${money(totals.grandTotal)}`] },
        terms: [],
        returns: 'Exchange within 7 days with this bill.',
        declaration: null,
        notes: null,
        signatory: null,
        footer: { lines: ['Questions? Call or WhatsApp +91 98450 00000'], computerGenerated: COMPUTER_BILL, note: 'Thank you for shopping with us.' },
        cancelled: null,
        currency: 'INR',
    };
}

/** A partial credit note against the first invoice: its reference and reason, "Amount credited", and a signature photographed on a phone (a JPEG stored on its side). */
function creditNote(): DocumentModel {
    const heads = 'CGST_SGST';
    const lines = inclusive([{ name: 'Handblock Cotton Kurta', detail: 'Indigo / M · SJ-KUR-IND-M', hsn: '6211', quantity: 1, unit: 'PCS', price: 1499, discount: 150, gst: 5 }], heads);
    const totals = totalsOf(lines, { grandLabel: 'Amount credited' });
    return {
        kind: 'CREDIT_NOTE',
        theme: 'modern',
        brandColor: '#0F766E',
        documentNumber: 'CN-26-27/000012',
        title: 'CREDIT NOTE',
        subtitle: null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: SAANJH,
        status: { chip: null, line: 'Against INV-26-27/000124', amount: totals.grandTotal, note: null },
        details: [
            { label: 'Credit note No.', value: 'CN-26-27/000012' },
            { label: 'Credit note date', value: '2 Nov 2026' },
            { label: 'Order No.', value: '#1042' },
            { label: 'Place of supply', value: 'Karnataka (29)' },
            { label: 'Supply type', value: 'Intra-state' },
            { label: 'Reverse charge', value: 'No' },
        ],
        reference: ['Against invoice INV-26-27/000124 dated 27 Oct 2026', 'Reason: Returned unworn, wrong size'],
        parties: [ASHA],
        taxHeads: heads,
        showHsn: true,
        showDiscount: true,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: null,
        payment: null,
        terms: [],
        returns: null,
        declaration: null,
        notes: null,
        signatory: { ...SAANJH_SIGNATORY, image: image('signature-photo.jpg', 'jpg') },
        footer: { lines: SAANJH_FOOTER, computerGenerated: null, note: null },
        cancelled: null,
        currency: 'INR',
    };
}

/** A till sale by a business without GST: no GSTIN, copy mark, HSN or tax; round-off and two payments. */
function bill(): DocumentModel {
    const lines = exclusive(
        [
            { name: 'Masala Chai', quantity: 2, unit: 'NOS', price: 60, gst: 0 },
            { name: 'Filter Coffee', quantity: 2, unit: 'NOS', price: 70, gst: 0 },
            { name: 'Paneer Kathi Roll', quantity: 1, unit: 'NOS', price: 189.5, gst: 0 },
            { name: 'Lemon Cooler', quantity: 1, unit: 'NOS', price: 99.75, gst: 0 },
        ],
        null,
    );
    const totals = totalsOf(lines, { roundTo: true, grandLabel: 'Net payable' });
    return {
        kind: 'BILL',
        theme: 'modern',
        brandColor: '#166534',
        documentNumber: '#M1004',
        title: 'BILL',
        subtitle: null,
        copyMark: null,
        seller: {
            tradeName: 'Nimbu Tree Café',
            legalName: 'Nimbu Tree Foods',
            addressLines: ['7, Church Street', 'Bengaluru 560001'],
            contactLine: '+91 98450 11111 · nimbutree.example',
            gstin: null,
            state: null,
            ids: [{ label: 'FSSAI Lic. No.', value: '21223010001234' }],
            dispatchFrom: null,
            logo: null,
        },
        status: { chip: { text: 'PAID', tone: 'paid' }, line: 'Paid at the counter', amount: totals.grandTotal, note: 'Cash and UPI' },
        details: [
            { label: 'Bill No.', value: '#M1004' },
            { label: 'Date', value: '27 Oct 2026, 14:05' },
            { label: 'Till', value: 'Counter 2' },
            { label: 'Cashier', value: 'Ravi' },
        ],
        reference: [],
        parties: [],
        taxHeads: null,
        showHsn: false,
        showDiscount: false,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: null,
        payment: { kind: 'received', lines: ['UPI · Ref 629312345678 · 27 Oct 2026, 14:06 · ₹200.00', 'Cash · Received ₹500.00 · Change ₹93.00 · ₹407.00'] },
        terms: [],
        returns: null,
        declaration: null,
        notes: null,
        signatory: null,
        footer: { lines: ['Questions? WhatsApp +91 98450 11111'], computerGenerated: COMPUTER_BILL, note: 'Thank you! Visit again.' },
        cancelled: null,
        currency: 'INR',
    };
}

/** A cancelled invoice: the CANCELLED watermark and chip. */
function cancelled(): DocumentModel {
    const heads = 'IGST';
    const lines = inclusive(
        [
            { name: 'Pure Silk Dupatta', detail: 'Rust · SJ-DUP-RST', hsn: '6214', quantity: 1, unit: 'PCS', price: 2999, gst: 18 },
            { name: 'Linen Palazzo Pants', detail: 'Beige / M · SJ-PLZ-BEI-M', hsn: '6204', quantity: 1, unit: 'PCS', price: 1299, gst: 5 },
        ],
        heads,
    );
    const totals = totalsOf(lines);
    return {
        kind: 'TAX_INVOICE',
        theme: 'modern',
        brandColor: '#0F766E',
        documentNumber: 'INV-26-27/000119',
        title: 'TAX INVOICE',
        subtitle: null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: SAANJH,
        status: { chip: { text: 'CANCELLED', tone: 'void' }, line: 'Cancelled on 28 Oct 2026', amount: totals.grandTotal, note: null },
        details: [
            { label: 'Invoice No.', value: 'INV-26-27/000119' },
            { label: 'Invoice date', value: '26 Oct 2026' },
            { label: 'Order No.', value: '#1037' },
            { label: 'Payment', value: 'Cash on delivery' },
            { label: 'Place of supply', value: 'Kerala (32)' },
            { label: 'Supply type', value: 'Inter-state (IGST)' },
            { label: 'Reverse charge', value: 'No' },
        ],
        reference: [],
        parties: [{ heading: 'BILL TO / SHIP TO', name: 'Anil Joseph', lines: ['Kurishupally Road, Ravipuram', 'Kochi 682016'], state: 'Kerala (32)', gstin: null }],
        taxHeads: heads,
        showHsn: true,
        showDiscount: false,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: summaryOf(lines),
        payment: null,
        terms: [],
        returns: null,
        declaration: null,
        notes: null,
        signatory: null,
        footer: { lines: SAANJH_FOOTER, computerGenerated: COMPUTER_INVOICE, note: null },
        cancelled: { on: '28 Oct 2026' },
        currency: 'INR',
    };
}

/** Names that wrap: a long legal and trading name, many IDs, a dispatch line, three-line item names, a crore-sized line, a long footer; part paid. */
function longNames(): DocumentModel {
    const heads = 'CGST_SGST';
    const lines = exclusive(
        [
            {
                name: 'Kanchipuram Pure Mulberry Silk Saree with Contrast Pallu, Gold Zari Border and Unstitched Blouse Piece',
                detail: 'Temple design, hand-woven · Peacock blue / Magenta · VH-KAN-TMP-PB-0042',
                hsn: '5007',
                quantity: 600,
                unit: 'PCS',
                price: 18500,
                discount: 25000,
                gst: 5,
            },
            {
                name: 'Soft Silk Saree with Woven Butta Motifs All Over and a Rich Pallu in Contrasting Colours',
                detail: 'Bottle green · VH-SFT-BUT-BG',
                hsn: '5007',
                quantity: 12,
                unit: 'PCS',
                price: 6200,
                gst: 5,
            },
            { name: 'Cotton Dhoti with Angavastram, 4 m', detail: 'Off-white / Gold · VH-DHT-ANGAVASTRAM-4M-OFFWHITE-GOLD-2026', hsn: '5208', quantity: 40, unit: 'PCS', price: 1150, gst: 5 },
        ],
        heads,
    );
    const totals = totalsOf(lines, { paid: 5000000 });
    const due = totals.balanceDue!;
    return {
        kind: 'TAX_INVOICE',
        theme: 'modern',
        brandColor: '#7C3AED',
        documentNumber: 'INV-26-27/001207',
        title: 'TAX INVOICE',
        subtitle: null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: {
            tradeName: 'Venkateshwara Handlooms of Kanchipuram',
            legalName: 'Sri Venkateshwara Handloom Weavers Co-operative Production and Sales Society Limited',
            addressLines: ['Door No. 148/2, Gandhi Road, Opposite Sri Kamakshi Amman Temple Car Street', 'Kanchipuram, Kancheepuram District, Tamil Nadu 631501'],
            contactLine: '+91 44 2722 0000 · +91 94440 00000 · customercare@venkateshwarahandlooms.example · venkateshwarahandlooms.example',
            gstin: '33AAAAV1234Q1Z9',
            state: 'Tamil Nadu (33)',
            ids: [
                { label: 'PAN', value: 'AAAAV1234Q' },
                { label: 'CIN', value: 'U17111TN1998PTC041234' },
                { label: 'Udyam Reg. No.', value: 'UDYAM-TN-03-0045678' },
                { label: 'IEC', value: 'AAAAV1234Q' },
                { label: 'LUT', value: 'AD330326001234X' },
                { label: 'Handloom Mark No.', value: 'HLM/TN/2019/00417' },
            ],
            dispatchFrom: 'Dispatched from: Warehouse No. 4, SIPCOT Industrial Park, Phase II, Irungattukottai, Sriperumbudur Taluk, Tamil Nadu 602117',
            logo: null,
        },
        status: { chip: { text: 'PARTLY PAID', tone: 'due' }, line: 'Due by 26 Nov 2026', amount: due, note: 'Advance of ₹50,00,000.00 received' },
        details: [
            { label: 'Invoice No.', value: 'INV-26-27/001207' },
            { label: 'Invoice date', value: '27 Oct 2026' },
            { label: 'Order No.', value: '#W-20261027-0042 (wholesale, Diwali consignment)' },
            { label: 'Order date', value: '12 Oct 2026' },
            { label: 'Payment', value: 'Part paid (NEFT advance)' },
            { label: 'Place of supply', value: 'Tamil Nadu (33)' },
            { label: 'Supply type', value: 'Intra-state' },
            { label: 'Reverse charge', value: 'No' },
            { label: 'Courier', value: 'Professional Couriers Surface Cargo' },
            { label: 'AWB', value: 'PCS-MAA-778899001122' },
        ],
        reference: [],
        parties: [
            {
                heading: 'BILL TO',
                name: 'Dr. Aishwarya Lakshminarayanan Subramaniam-Venkataraghavan',
                lines: ['Flat 11C, Tower 3, Prestige Bella Vista, Mount Poonamallee Road', 'Iyyappanthangal, Chennai 600056', '+91 98••••••21 · a•••@gmail.com'],
                state: 'Tamil Nadu (33)',
                gstin: null,
            },
            {
                heading: 'SHIP TO',
                name: 'Lakshminarayanan Silks and Sarees Emporium (Mylapore Flagship Showroom)',
                lines: ['No. 7, North Mada Street, Near Kapaleeshwarar Temple Tank', 'Mylapore, Chennai 600004'],
                state: 'Tamil Nadu (33)',
                gstin: null,
            },
        ],
        taxHeads: heads,
        showHsn: true,
        showDiscount: true,
        lines,
        totals,
        amountInWords: words(totals.grandTotal),
        taxSummary: summaryOf(lines),
        payment: {
            kind: 'due',
            amount: due,
            upiUri: `upi://pay?pa=venkateshwarahandlooms%40okicici&pn=Venkateshwara%20Handlooms%20of%20Kanchipuram&am=${due.toFixed(2)}&cu=INR&tn=INV-26-27%2F001207`,
            upiId: 'venkateshwarahandlooms@okicici',
        },
        terms: [
            'Payment of the balance is due within 30 days of the invoice date, by NEFT, RTGS or UPI to the accounts printed on our letterhead.',
            'Silk sarees are hand-woven: small irregularities in the weave and zari are a mark of handwork, not a defect.',
            'Dry clean only. Store wrapped in muslin, away from damp and direct sunlight, and refold every three months.',
            'Interest at 18% a year applies to amounts overdue.',
            'Subject to Kanchipuram jurisdiction.',
        ],
        returns:
            'Unused sarees with the Silk Mark tag intact can be exchanged within 10 days of delivery. Write to returns@venkateshwarahandlooms.example with your invoice number, or use https://docs.google.com/forms/d/e/1FAIpQLSdVenkateshwaraHandloomsReturnRequestForm2026/viewform?usp=sf_link',
        declaration: null,
        notes: 'Deliver to the showroom’s rear entrance between 10 am and 1 pm; call the store manager, Mr. Senthil, on arrival.',
        signatory: { forName: 'For Sri Venkateshwara Handloom Weavers Co-operative Production and Sales Society Limited', image: null, name: 'K. Raghunathan', designation: 'Secretary' },
        footer: {
            lines: [
                'Registered office: Door No. 148/2, Gandhi Road, Opposite Sri Kamakshi Amman Temple Car Street, Kanchipuram, Kancheepuram District, Tamil Nadu 631501 · CIN U17111TN1998PTC041234',
                'Questions about this order? WhatsApp +91 94440 00000 · customercare@venkateshwarahandlooms.example',
            ],
            computerGenerated: null,
            note: 'Vanakkam, and thank you for keeping the handloom tradition alive.',
        },
        cancelled: null,
        currency: 'INR',
    };
}

/** No logo and no trading name: the legal name is the wordmark. Ink only; amount in words switched off. */
function plainSeller(): DocumentModel {
    const heads = 'CGST_SGST';
    const lines = inclusive(
        [
            { name: 'Cotton Bedsheet, Double', detail: 'Blue checks · MT-BED-DBL-BC', hsn: '6304', quantity: 1, unit: 'PCS', price: 1199, gst: 5 },
            { name: 'Cotton Pillow Cover, pair', detail: 'Blue checks · MT-PIL-BC', hsn: '6304', quantity: 2, unit: 'PCS', price: 349, gst: 5 },
        ],
        heads,
    );
    const totals = totalsOf(lines);
    return {
        kind: 'TAX_INVOICE',
        theme: 'modern',
        brandColor: null,
        documentNumber: 'INV-26-27/000007',
        title: 'TAX INVOICE',
        subtitle: null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: {
            tradeName: null,
            legalName: 'Meenakshi Textiles',
            addressLines: ['14, South Masi Street', 'Madurai, Tamil Nadu 625001'],
            contactLine: null,
            gstin: '33AABFM1234N1Z1',
            state: 'Tamil Nadu (33)',
            ids: [{ label: 'PAN', value: 'AABFM1234N' }],
            dispatchFrom: null,
            logo: null,
        },
        status: { chip: { text: 'PAID', tone: 'paid' }, line: 'Paid on 27 Oct 2026', amount: totals.grandTotal, note: 'UPI' },
        details: [
            { label: 'Invoice No.', value: 'INV-26-27/000007' },
            { label: 'Invoice date', value: '27 Oct 2026' },
            { label: 'Order No.', value: '#1009' },
            { label: 'Payment', value: 'Prepaid (UPI)' },
            { label: 'Place of supply', value: 'Tamil Nadu (33)' },
            { label: 'Supply type', value: 'Intra-state' },
            { label: 'Reverse charge', value: 'No' },
        ],
        reference: [],
        parties: [{ heading: 'BILL TO / SHIP TO', name: 'Lakshmi Narayanan', lines: ['22, Anna Nagar East', 'Madurai 625020'], state: 'Tamil Nadu (33)', gstin: null }],
        taxHeads: heads,
        showHsn: true,
        showDiscount: false,
        lines,
        totals,
        amountInWords: null,
        taxSummary: null,
        payment: { kind: 'received', lines: [`UPI · Ref 430912345678 · 27 Oct 2026, 11:20 · ${money(totals.grandTotal)}`] },
        terms: [],
        returns: null,
        declaration: null,
        notes: null,
        signatory: null,
        footer: { lines: [], computerGenerated: COMPUTER_INVOICE, note: null },
        cancelled: null,
        currency: 'INR',
    };
}

/** Every fixture, by the name its PDF and pictures are saved under. */
export const DOCUMENT_FIXTURES = {
    'b2c-intra-paid-modern-hindi': b2cIntraPaid,
    'b2c-inter-discount-light-brand': b2cInterDiscount,
    'b2b-classic-26-lines-unpaid-qr': b2bClassic,
    'union-territory-utgst-cod': unionTerritory,
    'bill-of-supply-composition': billOfSupply,
    'credit-note-signed': creditNote,
    'bill-no-gst': bill,
    'cancelled-invoice': cancelled,
    'long-names': longNames,
    'no-logo-no-trade-name': plainSeller,
} satisfies Record<string, () => DocumentModel>;

export type FixtureName = keyof typeof DOCUMENT_FIXTURES;

/**
 * Variants only the spec renders: an amount in a currency other than the
 * rupee, a cancelled document over several pages, and blocks taller than a
 * page (notes listing 90 returned serial numbers, 90 terms), which react-pdf
 * cannot keep whole.
 */
export const SPEC_VARIANTS = {
    'bill-in-usd': (): DocumentModel => ({ ...bill(), currency: 'USD' }),
    'notes-longer-than-a-page': (): DocumentModel => ({
        ...creditNote(),
        notes: ['Serial numbers returned:', ...Array.from({ length: 90 }, (_, i) => `SN-2026-${100123 + i}`)].join('\n'),
        footer: { lines: SAANJH_FOOTER, computerGenerated: null, note: 'Thank you for shopping with us.' },
    }),
    'terms-longer-than-a-page': (): DocumentModel => ({ ...b2bClassic(), terms: Array.from({ length: 90 }, (_, i) => `Term number ${i + 1}.`) }),
    'cancelled-over-several-pages': (): DocumentModel => {
        const model = b2bClassic();
        return {
            ...model,
            status: { chip: { text: 'CANCELLED', tone: 'void' }, line: 'Cancelled on 28 Oct 2026', amount: model.totals.grandTotal, note: null },
            payment: null,
            cancelled: { on: '28 Oct 2026' },
        };
    },
} satisfies Record<string, () => DocumentModel>;

export type VariantName = keyof typeof SPEC_VARIANTS;
