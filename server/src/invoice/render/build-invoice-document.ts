import type { GstType, InvoiceStatus, OrderFinancialStatus, PaymentProvider, PosPaymentMethod } from '@prisma/client';
import { isCashOnDelivery } from '../../commerce/order-vars';
import { extractStateFromAddress } from '../../gst/place-of-supply.util';
import { displayVariantTitle } from '../../product/variant-title.util';
import { amountInWords } from './amount-in-words';
import {
    COMPOSITION_LINE,
    E_INVOICE_DECLARATION,
    addressField,
    addressLines,
    businessIds,
    buyerContactLine,
    computerGeneratedNote,
    docDate,
    docDateTime,
    footerLines,
    latest,
    methodsOf,
    returnsOf,
    round2,
    sellerContactLine,
    stateLabel,
    sum,
    termsOf,
    themeOf,
    tillMethodLabel,
    tillPaymentLine,
    tradeNameBeside,
    upiPayUri,
} from './build-parts';
import type {
    DocField,
    DocImage,
    DocLine,
    DocParty,
    DocPayment,
    DocSignatory,
    DocStatus,
    DocTaxHeads,
    DocTaxSummary,
    DocTaxSummaryRow,
    DocumentKind,
    DocumentModel,
} from './document-model';
import { formatMoney } from './money';
import type { RenderSnapshot } from './render-snapshot';

/** An invoice line as stored, amounts in rupees. */
export interface InvoiceLineForDocument {
    orderLineItemId: string | null;
    description: string;
    hsnCode: string | null;
    unitOfMeasure: string | null;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxableValue: number;
    gstRate: number;
    cgstRate: number;
    cgstAmount: number;
    sgstRate: number;
    sgstAmount: number;
    igstRate: number;
    igstAmount: number;
    totalAmount: number;
}

/** Everything `buildInvoiceDocument` reads, as build-loader.ts loads it. Amounts are numbers. */
export interface InvoiceDocumentInput {
    invoice: {
        invoiceNumber: string;
        invoiceDate: Date;
        status: InvoiceStatus;
        cancelledAt: Date | null;
        currency: string;
        gstType: GstType;
        reverseCharge: boolean;
        sellerLegalName: string;
        sellerGstin: string;
        sellerAddress: unknown;
        sellerStateCode: string;
        sellerStateName: string;
        dispatchName: string | null;
        dispatchAddress: unknown;
        buyerName: string;
        buyerGstin: string | null;
        buyerAddress: unknown;
        buyerStateCode: string;
        buyerStateName: string;
        placeOfSupply: string;
        placeOfSupplyName: string;
        subtotal: number;
        totalCgst: number;
        totalSgst: number;
        totalIgst: number;
        shippingCharge: number;
        grandTotal: number;
        notes: string | null;
        creditNoteReason: string | null;
        lineItems: InvoiceLineForDocument[];
    };
    /** The invoice a credit note reverses. */
    original: { invoiceNumber: string; invoiceDate: Date } | null;
    /** Read live: what the order is now, not what it was when the invoice was issued. */
    order: {
        name: string;
        /** `externalCreatedAt ?? createdAt`. */
        placedAt: Date;
        financialStatus: OrderFinancialStatus;
        paymentGateways: string[];
        /** `metadata.paymentMethod` of an order made in Collabo: CASH, CARD, UPI or OTHER. */
        paymentMethod: string | null;
        posSale: boolean;
        shippingAddress: unknown;
        customer: { phone: string | null; email: string | null } | null;
        lineItems: Array<{ id: string; title: string; variantTitle: string | null; sku: string | null }>;
        /** The latest fulfillment with tracking. */
        tracking: { company: string | null; number: string | null } | null;
        /** Taken at the till. */
        payments: Array<{ method: PosPaymentMethod; amount: number; reference: string | null; createdAt: Date }>;
        /** The payment link that paid the order: the first one paid, as any later one is refunded. */
        paymentLink: { provider: PaymentProvider; paymentMethod: string | null; paymentId: string | null; amountPaid: number; paidAt: Date | null } | null;
        /** The latest "paid" entry on the order's timeline. */
        paidEventAt: Date | null;
    };
    /** The invoice's own snapshot, or the current settings for one issued before snapshots. */
    snapshot: RenderSnapshot;
    logo: DocImage | null;
    signature: DocImage | null;
    timeZone: string;
    /** The tax settings' unit, for lines stored without one. */
    defaultUnit: string;
}

/** `INV-26-27/000036` → `INV-26-27-000036.pdf`; a slash is a path separator. */
export function invoicePdfFilename(invoiceNumber: string): string {
    return `${invoiceNumber.replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
}

const TITLES: Record<DocumentKind, string> = {
    TAX_INVOICE: 'TAX INVOICE',
    BILL_OF_SUPPLY: 'BILL OF SUPPLY',
    CREDIT_NOTE: 'CREDIT NOTE',
    BILL: 'BILL',
};

/** Union territories without a legislature: UTGST is charged where a state charges SGST. */
const UTGST_STATES = new Set(['04', '26', '31', '35', '38', '97']);

/** Money the order has received; refunds are credit notes, so a refunded order still reads as paid. */
const PAID_STATES = new Set<string>(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);

/** Only these are asked to pay by UPI: a gateway already holds an authorised payment, and a voided one owes nothing. */
const UPI_DUE_STATES = new Set<string>(['PENDING', 'PARTIALLY_PAID']);

/** The HSN stored before Phase 2 for "not classified": it prints as missing. */
const LEGACY_PLACEHOLDER_HSN = '0000';

const LINK_METHODS: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI', paylater: 'Pay later' };

/** Where the order's money stands, whatever the document's own status. */
type Settlement =
    | { state: 'paid'; at: Date | null }
    | { state: 'due'; paid: number; balance: number }
    /** Part paid by a channel that did not say how much. */
    | { state: 'part-unknown' };

/**
 * An issued invoice, a credit note or a cancelled invoice as the document it
 * prints (design section 4.3). Pure: build-loader.ts reads the database.
 */
export function buildInvoiceDocument(input: InvoiceDocumentInput): DocumentModel {
    const { invoice, order, snapshot, timeZone } = input;
    const { design, brand } = snapshot;
    const date = (d: Date) => docDate(d, timeZone);
    const money = (n: number) => formatMoney(n, invoice.currency);
    // A credit note is still one once cancelled: it is the row that reverses another.
    const isCredit = invoice.status === 'CREDIT_NOTE' || input.original !== null;
    const isCancelled = invoice.status === 'CANCELLED';
    const billOfSupply = snapshot.documentType === 'BILL_OF_SUPPLY';
    const kind: DocumentKind = isCredit ? 'CREDIT_NOTE' : snapshot.documentType;
    const taxHeads: DocTaxHeads = billOfSupply
        ? null
        : invoice.gstType === 'IGST'
          ? 'IGST'
          : UTGST_STATES.has(invoice.sellerStateCode)
            ? 'CGST_UTGST'
            : 'CGST_SGST';

    // A cash-on-delivery order paid by a payment link or at a till was not paid in cash.
    const cod = isCashOnDelivery(order.paymentGateways) && !order.paymentLink && order.payments.length === 0;
    const online = !order.posSale && !order.paymentMethod;
    const settlement = settlementOf(input);
    const via = paidVia(order);
    // Money is shown only on the live sale: a credit note and a cancelled invoice settle nothing.
    const live = !isCredit && !isCancelled;
    const due = live && settlement.state === 'due' ? settlement : null;
    const cancelledOn = invoice.cancelledAt ? date(invoice.cancelledAt) : null;

    const status: DocStatus = isCancelled
        ? { chip: { text: 'CANCELLED', tone: 'void' }, line: cancelledOn && `Cancelled on ${cancelledOn}`, amount: invoice.grandTotal, note: null }
        : isCredit
          ? { chip: null, line: input.original ? `Against ${input.original.invoiceNumber}` : null, amount: invoice.grandTotal, note: null }
          : settlement.state === 'paid'
            ? {
                  chip: { text: 'PAID', tone: 'paid' },
                  line: settlement.at && `Paid on ${date(settlement.at)}`,
                  amount: invoice.grandTotal,
                  note: cod ? 'Cash on delivery' : via,
              }
            : settlement.state === 'part-unknown'
              ? { chip: { text: 'PARTLY PAID', tone: 'due' }, line: null, amount: invoice.grandTotal, note: null }
              : cod
                ? { chip: { text: 'CASH ON DELIVERY', tone: 'due' }, line: 'Collect on delivery', amount: settlement.balance, note: null }
                : settlement.paid > 0
                  ? { chip: { text: 'PARTLY PAID', tone: 'due' }, line: 'Balance due', amount: settlement.balance, note: null }
                  : { chip: { text: 'UNPAID', tone: 'due' }, line: null, amount: settlement.balance, note: null };

    const paymentDetail = cod
        ? 'Cash on delivery'
        : settlement.state === 'paid'
          ? `${online ? 'Prepaid' : 'Paid'}${via ? ` (${via})` : ''}`
          : settlement.state === 'part-unknown' || settlement.paid > 0
            ? 'Partly paid'
            : 'Unpaid';
    const issued = date(invoice.invoiceDate);
    const placed = date(order.placedAt);
    const details: DocField[] = [
        { label: isCredit ? 'Credit note No.' : billOfSupply ? 'Bill No.' : 'Invoice No.', value: invoice.invoiceNumber },
        { label: isCredit ? 'Credit note date' : billOfSupply ? 'Bill date' : 'Invoice date', value: issued },
        { label: 'Order No.', value: order.name },
        ...(placed !== issued ? [{ label: 'Order date', value: placed }] : []),
        ...(isCredit ? [] : [{ label: 'Payment', value: paymentDetail }]),
        { label: 'Place of supply', value: stateLabel(invoice.placeOfSupply, invoice.placeOfSupplyName) ?? invoice.placeOfSupply },
        ...(billOfSupply
            ? []
            : [
                  { label: 'Supply type', value: invoice.gstType === 'IGST' ? 'Inter-state (IGST)' : 'Intra-state' },
                  { label: 'Reverse charge', value: invoice.reverseCharge ? 'Yes' : 'No' },
              ]),
        ...(!isCredit && order.tracking?.company ? [{ label: 'Courier', value: order.tracking.company }] : []),
        ...(!isCredit && order.tracking?.number ? [{ label: 'AWB', value: order.tracking.number }] : []),
    ];

    const sellerLines = addressLines(invoice.sellerAddress);
    const dispatchLines = addressLines(invoice.dispatchAddress);
    // Only when the goods left from somewhere other than the registered address.
    const dispatchFrom =
        invoice.dispatchName && dispatchLines.length > 0 && dispatchLines.join('|') !== sellerLines.join('|')
            ? `Dispatched from: ${[invoice.dispatchName, ...dispatchLines].join(', ')}`
            : null;

    const lines = documentLines(input, taxHeads);
    const units = new Set(invoice.lineItems.map((li) => li.unitOfMeasure || input.defaultUnit));
    const discount = sum(invoice.lineItems.map((li) => li.discount));
    // Only the part added on top of the lines: invoices that taxed shipping
    // into the lines still store the whole charge.
    const shipping = round2(
        Math.max(0, Math.min(invoice.shippingCharge, invoice.grandTotal - invoice.subtotal - invoice.totalCgst - invoice.totalSgst - invoice.totalIgst)),
    );

    const signatoryBlock = (image: DocImage | null): DocSignatory => ({
        forName: `For ${invoice.sellerLegalName}`,
        image,
        name: design.signatoryName.trim() || null,
        designation: design.signatoryDesignation.trim() || null,
    });
    // Rule 53 has no electronic exemption, so a credit note is always signed.
    const signatory = isCredit
        ? signatoryBlock(input.signature)
        : design.signatureMode === 'image'
          ? signatoryBlock(input.signature)
          : design.signatureMode === 'blank'
            ? signatoryBlock(null)
            : null;

    return {
        kind,
        theme: themeOf(design, invoice.buyerGstin),
        brandColor: design.brandColor,
        documentNumber: invoice.invoiceNumber,
        title: TITLES[kind],
        subtitle: snapshot.composition ? COMPOSITION_LINE : null,
        copyMark: 'ORIGINAL FOR RECIPIENT',
        seller: {
            tradeName: tradeNameBeside(brand.tradeName, invoice.sellerLegalName),
            legalName: invoice.sellerLegalName,
            addressLines: sellerLines,
            contactLine: sellerContactLine(design, brand),
            gstin: invoice.sellerGstin,
            state: stateLabel(invoice.sellerStateCode, invoice.sellerStateName),
            ids: businessIds(design, invoice.sellerGstin, 'onA4'),
            dispatchFrom,
            logo: input.logo,
        },
        status,
        details,
        reference: isCredit
            ? [
                  input.original && `Against invoice ${input.original.invoiceNumber} dated ${date(input.original.invoiceDate)}`,
                  invoice.creditNoteReason?.trim() && `Reason: ${invoice.creditNoteReason.trim()}`,
              ].filter((line): line is string => !!line)
            : [],
        parties: partiesOf(input),
        taxHeads,
        showHsn: true,
        showDiscount: lines.some((l) => l.discount > 0),
        lines,
        totals: {
            quantity: units.size === 1 && invoice.lineItems.every((li) => li.quantity > 0) ? invoice.lineItems.reduce((s, li) => s + li.quantity, 0) : null,
            // From the taxable value, so the ladder adds up to the paisa even where
            // a tax-inclusive price left rate × quantity a paisa off, and on a
            // credit note whose lines carry no quantity.
            itemValue: round2(invoice.subtotal + discount),
            discount,
            taxable: invoice.subtotal,
            cgst: invoice.totalCgst,
            sgst: invoice.totalSgst,
            igst: invoice.totalIgst,
            charges: shipping > 0 ? [{ label: 'Shipping (not taxed)', amount: shipping }] : [],
            roundOff: 0,
            grandLabel: isCredit ? 'Amount credited' : 'Grand total',
            grandTotal: invoice.grandTotal,
            paid: due ? due.paid : null,
            balanceDue: due ? due.balance : null,
        },
        amountInWords: design.amountInWords && invoice.currency === 'INR' ? amountInWords(invoice.grandTotal) : null,
        taxSummary: taxSummaryOf(input, taxHeads),
        payment: !live
            ? null
            : settlement.state === 'paid'
              ? { kind: 'received', lines: receivedLines(input, via, cod, money) }
              : settlement.state === 'due'
                ? duePayment(input, settlement.balance, cod)
                : null,
        terms: termsOf(design),
        returns: returnsOf(design),
        declaration: snapshot.eInvoiceDeclaration ? E_INVOICE_DECLARATION : null,
        notes: invoice.notes?.trim() || null,
        signatory,
        footer: {
            lines: footerLines(design, brand),
            computerGenerated: signatory ? null : computerGeneratedNote(kind),
            note: design.footerNote.trim() || null,
        },
        cancelled: isCancelled ? { on: cancelledOn ?? '' } : null,
        currency: invoice.currency,
    };
}

/** Paid, due with the balance, or part paid by an amount nobody recorded. */
function settlementOf({ invoice, order }: InvoiceDocumentInput): Settlement {
    const received = round2(sum(order.payments.map((p) => p.amount)) + (order.paymentLink?.amountPaid ?? 0));
    const balance = round2(invoice.grandTotal - received);
    if (PAID_STATES.has(order.financialStatus) || balance <= 0) {
        return { state: 'paid', at: latest([...order.payments.map((p) => p.createdAt), order.paymentLink?.paidAt]) ?? order.paidEventAt };
    }
    if (order.financialStatus === 'PARTIALLY_PAID' && received === 0) return { state: 'part-unknown' };
    return { state: 'due', paid: received, balance };
}

/** How the order was paid: the till's methods, the payment link, the method of an order made in Collabo, or the channel's gateways. */
function paidVia(order: InvoiceDocumentInput['order']): string | null {
    if (order.payments.length) return methodsOf(order.payments);
    if (order.paymentLink) return linkLabel(order.paymentLink);
    if (order.paymentMethod) return tillMethodLabel(order.paymentMethod);
    const gateways = order.paymentGateways.map((g) => g.trim().replace(/_/g, ' ')).filter(Boolean);
    return gateways.map((g) => g[0].toUpperCase() + g.slice(1)).join(', ') || null;
}

/** "UPI via Razorpay", "WhatsApp Pay". */
function linkLabel(link: NonNullable<InvoiceDocumentInput['order']['paymentLink']>): string {
    if (link.provider === 'WHATSAPP_PAY') return 'WhatsApp Pay';
    const method = link.paymentMethod ? (LINK_METHODS[link.paymentMethod.toLowerCase()] ?? link.paymentMethod) : null;
    return method ? `${method} via Razorpay` : 'Razorpay';
}

/** One line per payment; an order paid elsewhere gets its gateway and amount. */
function receivedLines(input: InvoiceDocumentInput, via: string | null, cod: boolean, money: (n: number) => string): string[] {
    const { order, invoice, timeZone } = input;
    const link = order.paymentLink;
    const lines = [
        ...order.payments.map((p) => tillPaymentLine({ ...p, at: p.createdAt }, timeZone, invoice.currency)),
        ...(link
            ? [
                  [linkLabel(link), link.paymentId && `Txn ID ${link.paymentId}`, link.paidAt && docDateTime(link.paidAt, timeZone), money(link.amountPaid)]
                      .filter(Boolean)
                      .join(' · '),
              ]
            : []),
    ];
    if (lines.length) return lines;
    const how = cod ? 'Cash on delivery' : via;
    return [how ? `${how} · ${money(invoice.grandTotal)}` : money(invoice.grandTotal)];
}

/** The balance, with a UPI QR when the settings ask for one and it can be paid by UPI. */
function duePayment({ invoice, order, snapshot }: InvoiceDocumentInput, balance: number, cod: boolean): DocPayment {
    const { design, brand } = snapshot;
    const asked = design.upiQr === 'unpaid' && !cod && UPI_DUE_STATES.has(order.financialStatus) && invoice.currency === 'INR';
    const upiId = asked && brand.upiId ? brand.upiId : null;
    return {
        kind: 'due',
        amount: balance,
        upiUri: upiId && upiPayUri(upiId, brand.tradeName.trim() || invoice.sellerLegalName, balance, invoice.invoiceNumber),
        upiId,
    };
}

function documentLines({ invoice, order, snapshot, defaultUnit }: InvoiceDocumentInput, taxHeads: DocTaxHeads): DocLine[] {
    const sources = new Map(order.lineItems.map((l) => [l.id, l]));
    const split = taxHeads === 'CGST_SGST' || taxHeads === 'CGST_UTGST';
    return invoice.lineItems.map((li, i) => {
        const source = li.orderLineItemId ? sources.get(li.orderLineItemId) : undefined;
        const detail = source
            ? [displayVariantTitle(source.variantTitle), snapshot.design.showSku ? source.sku?.trim() : null].filter(Boolean).join(' · ')
            : '';
        return {
            index: i + 1,
            name: source?.title ?? li.description,
            detail: detail || null,
            hsn: hsnOf(li.hsnCode),
            // A partial credit note credits value, not units: its lines carry no quantity.
            quantity: li.quantity > 0 ? `${li.quantity} ${li.unitOfMeasure || defaultUnit}` : '–',
            rate: li.unitPrice,
            discount: li.discount,
            taxable: li.taxableValue,
            cgst: split ? { amount: li.cgstAmount, rate: li.cgstRate } : null,
            sgst: split ? { amount: li.sgstAmount, rate: li.sgstRate } : null,
            igst: taxHeads === 'IGST' ? { amount: li.igstAmount, rate: li.igstRate } : null,
            amount: li.totalAmount,
        };
    });
}

const hsnOf = (hsn: string | null) => (hsn && hsn.trim() !== LEGACY_PLACEHOLDER_HSN ? hsn.trim() : null);

/** Bill to, and Ship to beside it when the order ships somewhere else. */
function partiesOf({ invoice, order, snapshot }: InvoiceDocumentInput): DocParty[] {
    const billLines = addressLines(invoice.buyerAddress);
    const contact = buyerContactLine(
        snapshot.design.customerContact,
        order.customer?.phone ?? (addressField(invoice.buyerAddress, 'phone') || null),
        order.customer?.email ?? null,
    );
    const bill = {
        name: invoice.buyerName,
        lines: contact ? [...billLines, contact] : billLines,
        state: stateLabel(invoice.buyerStateCode, invoice.buyerStateName),
        gstin: invoice.buyerGstin,
    };
    const shipLines = addressLines(order.shippingAddress);
    const same = (a: string[], b: string[]) => a.join('|').replace(/\s+/g, ' ').toLowerCase() === b.join('|').replace(/\s+/g, ' ').toLowerCase();
    if (shipLines.length === 0 || same(shipLines, billLines)) return [{ heading: 'BILL TO / SHIP TO', ...bill }];
    const shipName =
        addressField(order.shippingAddress, 'name') ||
        [addressField(order.shippingAddress, 'first_name'), addressField(order.shippingAddress, 'last_name')].filter(Boolean).join(' ') ||
        invoice.buyerName;
    return [
        { heading: 'BILL TO', ...bill },
        { heading: 'SHIP TO', name: shipName, lines: shipLines, state: stateLabel(extractStateFromAddress(order.shippingAddress)), gstin: null },
    ];
}

/** One row per HSN and rate: always for a registered buyer, otherwise as the settings say. */
function taxSummaryOf({ invoice, snapshot }: InvoiceDocumentInput, taxHeads: DocTaxHeads): DocTaxSummary | null {
    if (!taxHeads) return null;
    const groups = new Map<string, DocTaxSummaryRow>();
    for (const li of invoice.lineItems) {
        const hsn = hsnOf(li.hsnCode) ?? '–';
        const key = `${hsn}|${li.gstRate}`;
        const row = groups.get(key) ?? { hsn, rate: li.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0 };
        row.taxable = round2(row.taxable + li.taxableValue);
        row.cgst = round2(row.cgst + li.cgstAmount);
        row.sgst = round2(row.sgst + li.sgstAmount);
        row.igst = round2(row.igst + li.igstAmount);
        row.totalTax = round2(row.cgst + row.sgst + row.igst);
        groups.set(key, row);
    }
    const rows = [...groups.values()].sort((a, b) => (a.hsn === b.hsn ? a.rate - b.rate : a.hsn < b.hsn ? -1 : 1));
    const mode = snapshot.design.taxSummary;
    const shown = !!invoice.buyerGstin || mode === 'always' || (mode === 'auto' && rows.length > 1);
    if (!shown) return null;
    return {
        rows,
        total: {
            taxable: sum(rows.map((r) => r.taxable)),
            cgst: sum(rows.map((r) => r.cgst)),
            sgst: sum(rows.map((r) => r.sgst)),
            igst: sum(rows.map((r) => r.igst)),
            totalTax: sum(rows.map((r) => r.totalTax)),
        },
    };
}
