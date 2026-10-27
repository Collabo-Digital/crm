import { getFinancialYear } from '../../common/utils/zoned-date.util';
import { buildDocumentNumber, CREDIT_NOTE_PREFIX, resolveInvoicePrefix } from '../invoice-number.util';
import { buildBillDocument, type BillReceipt } from './build-bill-document';
import { buildInvoiceDocument, type InvoiceDocumentInput, type InvoiceLineForDocument } from './build-invoice-document';
import type { PreviewContext, PreviewRegistration } from './build-loader';
import { addressLine, round2, sum } from './build-parts';
import type { DocumentModel } from './document-model';

/**
 * The documents the settings page previews, built by the same builders as
 * real ones: the organization's own seller, logo, UPI id and edited settings
 * around sample buyers and goods.
 */

export const PREVIEW_SAMPLES = ['tax_invoice', 'tax_invoice_b2b', 'bill_of_supply', 'credit_note', 'bill'] as const;
export type PreviewSample = (typeof PREVIEW_SAMPLES)[number];

/** Who a sample is from when the organization has no GSTIN to show: its own name, a sample registration. */
const sampleRegistration = (legalName: string): PreviewRegistration => ({
    gstin: '29ABCDE1234F1Z5',
    legalName,
    address: { address1: 'No. 12, 100 Feet Road', address2: 'Indiranagar', city: 'Bengaluru', zip: '560038', province: 'Karnataka' },
    stateCode: '29',
    stateName: 'Karnataka',
});

interface SampleGood {
    title: string;
    variant: string;
    sku: string;
    hsn: string;
    price: number;
    quantity: number;
    discount: number;
    rate: number;
}

/** A home delivery: two rates, one discount, prices that include GST. */
const HOME_GOODS: SampleGood[] = [
    { title: 'Handblock Cotton Kurta', variant: 'Indigo / M', sku: 'SJ-KUR-IND-M', hsn: '6211', price: 1499, quantity: 1, discount: 150, rate: 5 },
    { title: 'Linen Palazzo Pants', variant: 'Beige / M', sku: 'SJ-PLZ-BEI-M', hsn: '6204', price: 1299, quantity: 1, discount: 0, rate: 5 },
    { title: 'Pure Silk Dupatta', variant: 'Rust', sku: 'SJ-DUP-RST', hsn: '6214', price: 2999, quantity: 1, discount: 0, rate: 18 },
];

/** A shop's order: eight lines by the dozen, priced before GST. */
const TRADE_GOODS: SampleGood[] = [
    { title: 'Cotton Kurta', variant: 'Indigo / S–XL', sku: 'SJ-1000', hsn: '6211', price: 520, quantity: 6, discount: 300, rate: 5 },
    { title: 'Linen Shirt', variant: 'Rust / S–XL', sku: 'SJ-1007', hsn: '6205', price: 630, quantity: 12, discount: 0, rate: 5 },
    { title: 'Chanderi Kurta Set', variant: 'Beige / S–XL', sku: 'SJ-1014', hsn: '6211', price: 2950, quantity: 18, discount: 0, rate: 18 },
    { title: 'Palazzo Pants', variant: 'Olive / S–XL', sku: 'SJ-1021', hsn: '6204', price: 850, quantity: 24, discount: 0, rate: 5 },
    { title: 'Cotton Dupatta', variant: 'Mustard', sku: 'SJ-1028', hsn: '6214', price: 960, quantity: 6, discount: 0, rate: 5 },
    { title: 'Printed Saree', variant: 'Ivory', sku: 'SJ-1035', hsn: '6211', price: 2950, quantity: 12, discount: 0, rate: 18 },
    { title: 'Kids Kurta Set', variant: 'Teal / 4–8 Y', sku: 'SJ-1042', hsn: '6204', price: 630, quantity: 18, discount: 300, rate: 5 },
    { title: 'Nehru Jacket', variant: 'Indigo / S–XL', sku: 'SJ-1049', hsn: '6214', price: 740, quantity: 24, discount: 0, rate: 5 },
];

const HOME_BUYER = {
    name: 'Asha Menon',
    phone: '+919847012345',
    email: 'asha.menon@example.com',
    address: { address1: 'Flat 4B, Palm Grove Apartments', address2: 'Kadavanthra', city: 'Kochi', zip: '682020', province: 'Kerala', province_code: 'KL' },
    stateCode: '32',
    stateName: 'Kerala',
};

const TRADE_BUYER = {
    name: 'Kavya Retail LLP',
    gstin: '29AAAFK0000A1Z5',
    phone: '+918041234567',
    email: 'accounts@kavyaretail.example',
    address: { address1: '45, Commercial Street', city: 'Bengaluru', zip: '560001', province: 'Karnataka', province_code: 'KA' },
    shipTo: {
        name: 'Kavya Retail LLP (Whitefield store)',
        address1: 'Unit 12, Phoenix Marketcity',
        address2: 'Whitefield Road',
        city: 'Bengaluru',
        zip: '560048',
        province: 'Karnataka',
        province_code: 'KA',
    },
    stateCode: '29',
    stateName: 'Karnataka',
};

/** Invoice lines as Collabo stores them, with the tax split for the supply. */
function invoiceLines(goods: SampleGood[], opts: { inclusive: boolean; intra: boolean; untaxed?: boolean }): InvoiceLineForDocument[] {
    return goods.map((g, i) => {
        const rate = opts.untaxed ? 0 : g.rate;
        const charged = round2(g.price * g.quantity - g.discount);
        const taxable = opts.inclusive ? round2((charged * 100) / (100 + rate)) : charged;
        const tax = opts.inclusive ? round2(charged - taxable) : round2((taxable * rate) / 100);
        const unitPrice = opts.inclusive ? round2((g.price * 100) / (100 + rate)) : g.price;
        const cgst = opts.intra ? round2(tax / 2) : 0;
        return {
            orderLineItemId: `sample_line_${i + 1}`,
            description: `${g.title} - ${g.variant}`,
            hsnCode: g.hsn,
            unitOfMeasure: 'PCS',
            quantity: g.quantity,
            unitPrice,
            discount: g.discount > 0 ? round2(unitPrice * g.quantity - taxable) : 0,
            taxableValue: taxable,
            gstRate: rate,
            cgstRate: opts.intra ? rate / 2 : 0,
            cgstAmount: cgst,
            sgstRate: opts.intra ? rate / 2 : 0,
            sgstAmount: opts.intra ? round2(tax - cgst) : 0,
            igstRate: opts.intra ? 0 : rate,
            igstAmount: opts.intra ? 0 : tax,
            totalAmount: round2(taxable + tax),
        };
    });
}

/** A partial credit note's lines as Collabo raises them: every line scaled by one share, with no quantity. */
function creditLines(lines: InvoiceLineForDocument[], amount: number): InvoiceLineForDocument[] {
    const ratio = amount / sum(lines.map((l) => l.totalAmount));
    const scaled = lines.map((l) => {
        const taxableValue = round2(l.taxableValue * ratio);
        const cgstAmount = round2(l.cgstAmount * ratio);
        const sgstAmount = round2(l.sgstAmount * ratio);
        const igstAmount = round2(l.igstAmount * ratio);
        return {
            ...l,
            quantity: 0,
            discount: round2(l.discount * ratio),
            taxableValue,
            cgstAmount,
            sgstAmount,
            igstAmount,
            totalAmount: round2(taxableValue + cgstAmount + sgstAmount + igstAmount),
        };
    });
    const largest = scaled.reduce((a, b) => (b.taxableValue > a.taxableValue ? b : a));
    const drift = round2(amount - sum(scaled.map((l) => l.totalAmount)));
    largest.taxableValue = round2(largest.taxableValue + drift);
    largest.totalAmount = round2(largest.totalAmount + drift);
    return scaled;
}

function sampleInvoice(sample: Exclude<PreviewSample, 'bill'>, context: PreviewContext, now: Date): InvoiceDocumentInput {
    const { settings } = context;
    const seller = context.registration ?? sampleRegistration(settings.orgName);
    const financialYear = getFinancialYear(now, settings.timeZone);
    const prefix = resolveInvoicePrefix(settings.tax.invoicePrefix);
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

    const trade = sample === 'tax_invoice_b2b';
    const counter = sample === 'bill_of_supply';
    // A composition seller supplies only within its own state: the bill of supply is a walk-in at the counter.
    const buyer = trade
        ? { ...TRADE_BUYER, shippingAddress: TRADE_BUYER.shipTo }
        : counter
          ? { name: 'Walk-in customer', gstin: null, phone: null, email: null, address: null, shippingAddress: null, stateCode: seller.stateCode, stateName: seller.stateName }
          : { ...HOME_BUYER, gstin: null, shippingAddress: HOME_BUYER.address };
    const intra = buyer.stateCode === seller.stateCode;
    const goods = trade ? TRADE_GOODS : HOME_GOODS;
    const sold = invoiceLines(goods, { inclusive: !trade, intra, untaxed: counter });
    const lines = sample === 'credit_note' ? creditLines(sold, 2999) : sold;
    const total = (pick: (l: InvoiceLineForDocument) => number) => sum(lines.map(pick));
    const grandTotal = total((l) => l.totalAmount);
    const invoiceNumber =
        sample === 'credit_note'
            ? buildDocumentNumber(CREDIT_NOTE_PREFIX, financialYear, 9)
            : buildDocumentNumber(prefix, financialYear, { tax_invoice: 124, tax_invoice_b2b: 125, bill_of_supply: 126 }[sample]);

    return {
        invoice: {
            invoiceNumber,
            invoiceDate: now,
            status: sample === 'credit_note' ? 'CREDIT_NOTE' : 'ISSUED',
            cancelledAt: null,
            currency: 'INR',
            gstType: intra ? 'CGST_SGST' : 'IGST',
            reverseCharge: false,
            sellerLegalName: seller.legalName,
            sellerGstin: seller.gstin,
            sellerAddress: seller.address,
            sellerStateCode: seller.stateCode,
            sellerStateName: seller.stateName,
            dispatchName: null,
            dispatchAddress: null,
            buyerName: buyer.name,
            buyerGstin: buyer.gstin,
            buyerAddress: buyer.address,
            buyerStateCode: buyer.stateCode,
            buyerStateName: buyer.stateName,
            placeOfSupply: buyer.stateCode,
            placeOfSupplyName: buyer.stateName,
            subtotal: total((l) => l.taxableValue),
            totalCgst: total((l) => l.cgstAmount),
            totalSgst: total((l) => l.sgstAmount),
            totalIgst: total((l) => l.igstAmount),
            shippingCharge: 0,
            grandTotal,
            notes: trade ? 'Buyer PO: KR/PO/0412' : null,
            creditNoteReason: sample === 'credit_note' ? 'Returned: Pure Silk Dupatta, Rust' : null,
            lineItems: lines,
        },
        original: sample === 'credit_note' ? { invoiceNumber: buildDocumentNumber(prefix, financialYear, 124), invoiceDate: daysAgo(1) } : null,
        order: {
            name: counter ? '#M1044' : trade ? '#1043' : '#1042',
            placedAt: counter ? now : daysAgo(2),
            financialStatus: trade ? 'PENDING' : 'PAID',
            paymentGateways: trade ? [] : ['razorpay'],
            paymentMethod: counter ? 'CASH' : null,
            posSale: counter,
            shippingAddress: buyer.shippingAddress,
            customer: buyer.phone ? { phone: buyer.phone, email: buyer.email } : null,
            lineItems: goods.map((g, i) => ({ id: `sample_line_${i + 1}`, title: g.title, variantTitle: g.variant, sku: g.sku })),
            tracking: trade || counter ? null : { company: 'Delhivery', number: '1490000000000' },
            payments: counter ? [{ method: 'CASH', amount: grandTotal, reference: null, createdAt: now }] : [],
            paymentLink:
                trade || counter
                    ? null
                    : { provider: 'RAZORPAY', paymentMethod: 'upi', paymentId: 'pay_SAMPLE7Hx2', amountPaid: total((l) => l.totalAmount), paidAt: daysAgo(2) },
            paidEventAt: null,
        },
        snapshot: {
            v: 1,
            documentType: counter ? 'BILL_OF_SUPPLY' : 'TAX_INVOICE',
            composition: counter,
            eInvoiceDeclaration: settings.tax.eInvoicing && !buyer.gstin,
            design: context.design,
            brand: settings.brand,
        },
        logo: context.logo,
        signature: context.signature,
        timeZone: settings.timeZone,
        defaultUnit: settings.tax.defaultUnitOfMeasure,
    };
}

/** A till sale paid by UPI and cash, from a store with no GST invoice to issue. */
function sampleBill(context: PreviewContext, now: Date): BillReceipt {
    const { settings, registration } = context;
    return {
        footer: null,
        store: {
            name: settings.brand.tradeName,
            legalName: registration?.legalName ?? null,
            address: settings.storeAddress ?? addressLine(registration?.address),
            gstin: registration?.gstin ?? null,
        },
        order: { name: '#M1003', createdAt: now.toISOString(), staffName: 'Ravi', storeName: null },
        customer: { name: HOME_BUYER.name, phone: HOME_BUYER.phone, gstin: null },
        lines: [
            { title: 'Cotton Kurta', variantTitle: 'Blue / M', hsn: '6211', quantity: 1, unitPrice: 1299, discount: 129 },
            { title: 'Cotton Socks 3-Pack', variantTitle: 'Assorted', hsn: '6115', quantity: 2, unitPrice: 297, discount: 0 },
            { title: 'Silk Stole', variantTitle: 'Rust', hsn: '6214', quantity: 1, unitPrice: 2999, discount: 229 },
        ],
        totals: { subtotal: 4892, discount: 358, roundOff: 0, total: 4534, payable: 4534 },
        payments: [
            { method: 'UPI', amount: 1500, reference: '629312345678', at: now.toISOString() },
            { method: 'CASH', amount: 3034, reference: null, at: now.toISOString() },
        ],
        paid: 4534,
        balanceDue: 0,
    };
}

/** The document a preview shows. */
export function previewDocument(sample: PreviewSample, context: PreviewContext, now = new Date()): DocumentModel {
    if (sample === 'bill') {
        const { settings } = context;
        return buildBillDocument(sampleBill(context, now), {
            design: context.design,
            brand: settings.brand,
            logo: context.logo,
            timeZone: settings.timeZone,
            currency: settings.currency,
        });
    }
    return buildInvoiceDocument(sampleInvoice(sample, context, now));
}
