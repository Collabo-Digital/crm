/**
 * Everything one A4 document prints, worked out before it is drawn: the
 * builders (build-*.ts) decide WHAT appears, from the database, the settings
 * and the render snapshot; the renderer (document-pdf.tsx) decides only WHERE.
 * So the renderer holds no tax or business rules, and every decision here can
 * be tested without drawing a PDF.
 *
 * Text arrives final: dates and labels are formatted, states read
 * "Kerala (32)". Amounts arrive as numbers in rupees; the renderer formats
 * them with Indian digit grouping and two decimals, adding the currency sign
 * only where noted.
 */

/** TAX_INVOICE and BILL_OF_SUPPLY are GST documents; BILL is a sale by a business without GST. */
export type DocumentKind = 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'CREDIT_NOTE' | 'BILL';
export type DocumentTheme = 'modern' | 'classic';

/** An image the PDF embeds: react-pdf takes PNG and JPEG bytes. */
export interface DocImage {
    data: Buffer;
    format: 'png' | 'jpg';
}

export interface DocField {
    label: string;
    value: string;
}

export interface DocSeller {
    /** The brand line, set large when there is no logo. Null when it would repeat `legalName`. */
    tradeName: string | null;
    legalName: string;
    addressLines: string[];
    /** "+91 80 4000 0000 · care@brand.in · brand.in", or null. */
    contactLine: string | null;
    gstin: string | null;
    /** "Karnataka (29)"; with `gstin`, prints "GSTIN … · State: …". */
    state: string | null;
    /** PAN, CIN, FSSAI… in order, on one or two lines. */
    ids: DocField[];
    /** "Dispatched from: Whitefield warehouse, …", when the goods left another place of business. */
    dispatchFrom: string | null;
    logo: DocImage | null;
}

/** The right of the header: where the document stands, at a glance on a phone. */
export interface DocStatus {
    chip: { text: string; tone: 'paid' | 'due' | 'neutral' | 'void' } | null;
    /** "Paid on 25 Oct 2026", "Due by 11 Nov 2026", "Collect on delivery". */
    line: string | null;
    /** Printed large, with the currency sign: the grand total, the balance due, or the amount credited. */
    amount: number;
    /** "UPI via Razorpay", "Credit terms: 15 days". */
    note: string | null;
}

export interface DocParty {
    /** "BILL TO", "SHIP TO", or "BILL TO / SHIP TO" when they are the same. */
    heading: string;
    name: string;
    /** Address lines, then the buyer's contact line when the settings show it. */
    lines: string[];
    /** "Kerala (32)", printed as "State: Kerala (32)". */
    state: string | null;
    gstin: string | null;
}

/**
 * Which tax columns the item table, totals and summary carry. Null for a Bill
 * of Supply and a BILL: no tax columns at all. CGST_UTGST prints UTGST where a
 * CGST_SGST document prints SGST; the amounts are the `sgst` fields.
 */
export type DocTaxHeads = 'CGST_SGST' | 'CGST_UTGST' | 'IGST' | null;

export interface DocTaxCell {
    amount: number;
    /** Percent, e.g. 2.5; printed "@2.5%" under the amount. */
    rate: number;
}

export interface DocLine {
    /** 1-based, as printed. */
    index: number;
    name: string;
    /** "Indigo / M · SJ-KUR-IND-M": variant and SKU, small and grey under the name. */
    detail: string | null;
    hsn: string | null;
    /** "2 PCS": quantity with its unit (Rule 46(i)). */
    quantity: string;
    /** Per unit, before discount and before tax. */
    rate: number;
    /** 0 when none; printed as "−142.86". */
    discount: number;
    taxable: number;
    /** Set for the heads in `taxHeads`, null otherwise. */
    cgst: DocTaxCell | null;
    sgst: DocTaxCell | null;
    igst: DocTaxCell | null;
    amount: number;
}

export interface DocAmount {
    label: string;
    amount: number;
}

export interface DocTotals {
    /** Sum of quantities for the Total row; null when lines use different units. */
    quantity: number | null;
    /** Before discount. Printed with "Less: discount" only when `discount` is not 0. */
    itemValue: number;
    discount: number;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    /** Charges added after tax and not taxed, e.g. "Shipping (not taxed)". */
    charges: DocAmount[];
    /** Printed "Round off (+/−)" when not 0. */
    roundOff: number;
    /** "Grand total", "Amount credited", "Net payable". */
    grandLabel: string;
    grandTotal: number;
    /** Both set only while money is due: printed under the grand total. */
    paid: number | null;
    balanceDue: number | null;
}

export interface DocTaxSummaryRow {
    hsn: string;
    /** Percent: the full GST rate of the row. */
    rate: number;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalTax: number;
}

/** HSN-wise summary: one row per HSN and rate, columns as `taxHeads`. */
export interface DocTaxSummary {
    rows: DocTaxSummaryRow[];
    total: Omit<DocTaxSummaryRow, 'hsn' | 'rate'>;
}

export type DocPayment =
    /** One line per payment: "UPI · Txn ID pay_… · 25 Oct 2026, 18:42 · ₹5,647.00". */
    | { kind: 'received'; lines: string[] }
    /**
     * Money is due. `upiUri` is a `upi://pay?…` link the renderer draws as a QR
     * labelled "Scan to pay ₹…", with `upiId` beside it; null prints the amount only.
     */
    | { kind: 'due'; amount: number; upiUri: string | null; upiId: string | null };

export interface DocSignatory {
    /** "For Saanjh Apparel Private Limited". */
    forName: string;
    /** Null leaves space to sign by hand. */
    image: DocImage | null;
    name: string | null;
    designation: string | null;
}

export interface DocumentModel {
    kind: DocumentKind;
    theme: DocumentTheme;
    /** `#RRGGBB` for the Modern accents, or null for ink. The renderer keeps light colours off text. */
    brandColor: string | null;
    /** For the PDF's metadata and the strip on continuation pages: "INV-26-27/000124". */
    documentNumber: string;
    /** "TAX INVOICE", "BILL OF SUPPLY", "CREDIT NOTE", "BILL". */
    title: string;
    /** Under the title, e.g. the composition line "Composition taxable person, not eligible to collect tax on supplies". */
    subtitle: string | null;
    /** Boxed at the top right of every page, e.g. "ORIGINAL FOR RECIPIENT". */
    copyMark: string | null;
    seller: DocSeller;
    status: DocStatus;
    /** Label and value pairs in reading order; laid out in two or three columns. */
    details: DocField[];
    /** A credit note's "Against invoice INV-… dated 27 Oct 2026", and its reason. */
    reference: string[];
    /** One block, or Bill to and Ship to side by side. */
    parties: DocParty[];
    taxHeads: DocTaxHeads;
    showHsn: boolean;
    /** True when any line has a discount; otherwise there is no discount column. */
    showDiscount: boolean;
    lines: DocLine[];
    totals: DocTotals;
    /** "Rupees Five Thousand Six Hundred Forty-Seven Only", or null when switched off. */
    amountInWords: string | null;
    taxSummary: DocTaxSummary | null;
    payment: DocPayment | null;
    /** Printed numbered. */
    terms: string[];
    returns: string | null;
    /** A statutory declaration, e.g. Rule 46(s), printed in full. */
    declaration: string | null;
    notes: string | null;
    /** Null: no block, and `footer.computerGenerated` carries the note. Always set on a credit note. */
    signatory: DocSignatory | null;
    footer: {
        /** "Registered office: … · CIN …", "Questions about this order? WhatsApp … · email". */
        lines: string[];
        /** "This is a computer-generated invoice and does not need a signature." */
        computerGenerated: string | null;
        /** The brand's own line, e.g. "Thank you for shopping with us." */
        note: string | null;
    };
    /** A cancelled document: a CANCELLED watermark and "Cancelled on …". */
    cancelled: { on: string } | null;
    /** ISO code; INR prints "₹", anything else its code. */
    currency: string;
}
