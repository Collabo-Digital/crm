import type { InvoiceSettings } from '../../organization-settings/schemas/invoice-settings.schema';
import { displayVariantTitle } from '../../product/variant-title.util';
import { amountInWords } from './amount-in-words';
import {
    type DocumentBrand,
    businessIds,
    buyerContactLine,
    computerGeneratedNote,
    docDate,
    footerLines,
    latest,
    methodsOf,
    returnsOf,
    round2,
    sellerContactLine,
    stateLabel,
    termsOf,
    themeOf,
    tillPaymentLine,
    tradeNameBeside,
    upiPayUri,
} from './build-parts';
import type { DocImage, DocLine, DocumentModel } from './document-model';

/** What a bill reads of a till receipt (`PosReceiptService.receipt`). */
export interface BillReceipt {
    footer: string | null;
    store: { name: string; legalName: string | null; address: string | null; gstin: string | null };
    order: { name: string; createdAt: string; staffName: string | null; storeName: string | null };
    customer: { name: string | null; phone: string | null; gstin: string | null } | null;
    lines: Array<{ title: string; variantTitle: string | null; hsn: string | null; quantity: number; unitPrice: number; discount: number }>;
    totals: { subtotal: number; discount: number; roundOff: number; total: number; payable: number };
    payments: Array<{ method: string; amount: number; reference: string | null; at: string }>;
    paid: number;
    balanceDue: number;
}

/** A bill prints the current settings: it has no snapshot. */
export interface BillContext {
    design: InvoiceSettings;
    brand: DocumentBrand;
    logo: DocImage | null;
    timeZone: string;
    currency: string;
}

/** `#M1042` → `Bill-M1042.pdf`; a slash is a path separator and `#` cuts a link short. */
export function billPdfFilename(number: string): string {
    return `Bill-${number.replace(/[\\/:*?"<>|#]+/g, '-').replace(/^-+|-+$/g, '')}.pdf`;
}

/**
 * A till sale with no GST invoice as an A4 bill (design section 4.3): the
 * store and its contacts, the GSTIN only when the receipt has one, no tax
 * columns, the receipt's lines, round-off and payable, its payments as
 * received or its balance as due.
 */
export function buildBillDocument(receipt: BillReceipt, context: BillContext): DocumentModel {
    const { design, brand, timeZone, currency } = context;
    const legalName = receipt.store.legalName ?? receipt.store.name;
    const settled = receipt.balanceDue <= 0;
    const via = methodsOf(receipt.payments);
    const payable = receipt.totals.payable;

    const lines: DocLine[] = receipt.lines.map((l, i) => {
        const value = round2(l.unitPrice * l.quantity - l.discount);
        return {
            index: i + 1,
            name: l.title,
            detail: displayVariantTitle(l.variantTitle),
            hsn: l.hsn,
            quantity: String(l.quantity),
            rate: l.unitPrice,
            discount: l.discount,
            taxable: value,
            cgst: null,
            sgst: null,
            igst: null,
            amount: value,
        };
    });
    const { subtotal, discount } = receipt.totals;
    // GST a registered business charged on top of its prices, on a sale that
    // has no invoice yet: one line, so the totals still add up.
    const tax = round2(receipt.totals.total - (subtotal - discount));
    const upiId = !settled && design.upiQr === 'unpaid' && currency === 'INR' && brand.upiId ? brand.upiId : null;

    return {
        kind: 'BILL',
        theme: themeOf(design, receipt.customer?.gstin ?? null),
        brandColor: design.brandColor,
        documentNumber: receipt.order.name,
        title: 'BILL',
        subtitle: null,
        copyMark: null,
        seller: {
            tradeName: tradeNameBeside(receipt.store.name, legalName),
            legalName,
            addressLines: receipt.store.address ? [receipt.store.address] : [],
            contactLine: sellerContactLine(design, brand),
            gstin: receipt.store.gstin,
            state: stateLabel(receipt.store.gstin?.slice(0, 2)),
            ids: businessIds(design, receipt.store.gstin, 'onA4'),
            dispatchFrom: null,
            logo: context.logo,
        },
        status: settled
            ? {
                  chip: { text: 'PAID', tone: 'paid' },
                  line: receipt.payments.length ? `Paid on ${docDate(latest(receipt.payments.map((p) => new Date(p.at)))!, timeZone)}` : null,
                  amount: payable,
                  note: via,
              }
            : receipt.paid > 0
              ? { chip: { text: 'PARTLY PAID', tone: 'due' }, line: 'Balance due', amount: receipt.balanceDue, note: null }
              : { chip: { text: 'UNPAID', tone: 'due' }, line: null, amount: receipt.balanceDue, note: null },
        details: [
            { label: 'Bill No.', value: receipt.order.name },
            { label: 'Bill date', value: docDate(new Date(receipt.order.createdAt), timeZone) },
            { label: 'Payment', value: settled ? `Paid${via ? ` (${via})` : ''}` : receipt.paid > 0 ? 'Partly paid' : 'Unpaid' },
            ...(receipt.order.staffName ? [{ label: 'Billed by', value: receipt.order.staffName }] : []),
            ...(receipt.order.storeName && receipt.order.storeName !== receipt.store.name ? [{ label: 'Store', value: receipt.order.storeName }] : []),
        ],
        reference: [],
        parties: [
            {
                heading: 'BILL TO',
                name: receipt.customer?.name || 'Walk-in customer',
                lines: [buyerContactLine(design.customerContact, receipt.customer?.phone ?? null, null)].filter((l): l is string => !!l),
                state: null,
                gstin: receipt.customer?.gstin ?? null,
            },
        ],
        taxHeads: null,
        showHsn: false,
        showDiscount: lines.some((l) => l.discount > 0),
        lines,
        totals: {
            quantity: receipt.lines.reduce((s, l) => s + l.quantity, 0),
            itemValue: subtotal,
            discount,
            taxable: round2(subtotal - discount),
            cgst: 0,
            sgst: 0,
            igst: 0,
            charges: tax > 0 ? [{ label: 'GST', amount: tax }] : [],
            roundOff: receipt.totals.roundOff,
            grandLabel: 'Net payable',
            grandTotal: payable,
            paid: settled ? null : receipt.paid,
            balanceDue: settled ? null : receipt.balanceDue,
        },
        amountInWords: design.amountInWords && currency === 'INR' ? amountInWords(payable) : null,
        taxSummary: null,
        payment: settled
            ? receipt.payments.length
                ? { kind: 'received', lines: receipt.payments.map((p) => tillPaymentLine({ ...p, at: new Date(p.at) }, timeZone, currency)) }
                : null
            : {
                  kind: 'due',
                  amount: receipt.balanceDue,
                  upiUri: upiId && upiPayUri(upiId, brand.tradeName.trim() || legalName, receipt.balanceDue, receipt.order.name),
                  upiId,
              },
        terms: termsOf(design),
        returns: returnsOf(design),
        declaration: null,
        notes: receipt.footer,
        signatory: null,
        footer: {
            lines: footerLines(design, brand),
            computerGenerated: computerGeneratedNote('BILL'),
            note: design.footerNote.trim() || null,
        },
        cancelled: null,
        currency,
    };
}
