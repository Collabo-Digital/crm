import type * as ReactPdf from '@react-pdf/renderer';

/**
 * The GST invoice as a PDF: the file customers are sent on WhatsApp and the
 * one the app downloads, so both are always the same document.
 *
 * Mirrors the on-screen document (client invoice-document.tsx) section for
 * section. Amounts print as `INR 1,118.00` style figures: the built-in PDF
 * fonts carry no rupee glyph.
 */

type Amount = number | string | null | undefined;

interface InvoiceLine {
    id: string;
    description: string;
    hsnCode: string | null;
    quantity: number;
    unitPrice: Amount;
    discount: Amount;
    taxableValue: Amount;
    cgstRate: Amount;
    cgstAmount: Amount;
    sgstRate: Amount;
    sgstAmount: Amount;
    igstRate: Amount;
    igstAmount: Amount;
    totalAmount: Amount;
}

/** The fields of an invoice detail (InvoiceService.findOne) the document prints. */
export interface InvoiceForPdf {
    invoiceNumber: string;
    invoiceDate: Date | string;
    financialYear: string;
    status: string;
    cancelledAt: Date | string | null;
    currency: string | null;
    gstType: string;
    reverseCharge: boolean;
    sellerLegalName: string;
    sellerGstin: string;
    sellerStateCode: string;
    sellerStateName: string;
    sellerAddress: unknown;
    dispatchName: string | null;
    dispatchAddress: unknown;
    buyerName: string;
    buyerGstin: string | null;
    buyerStateCode: string;
    buyerStateName: string;
    buyerAddress: unknown;
    placeOfSupply: string;
    placeOfSupplyName: string;
    subtotal: Amount;
    totalDiscount: Amount;
    shippingCharge: Amount;
    totalCgst: Amount;
    totalSgst: Amount;
    totalIgst: Amount;
    grandTotal: Amount;
    notes: string | null;
    lineItems: InvoiceLine[];
}

const ALIASES: Record<string, readonly string[]> = {
    address1: ['address1', 'address_1'],
    address2: ['address2', 'address_2'],
    city: ['city'],
    province: ['province', 'province_code', 'state'],
    zip: ['zip', 'postal_code', 'pincode'],
    country: ['country', 'country_code'],
    company: ['company'],
};

/** Display lines of a loosely typed address blob (Shopify snake_case or CRM camelCase). */
export function addressLines(address: unknown): string[] {
    const a = (address && typeof address === 'object' ? address : {}) as Record<string, unknown>;
    const pick = (field: string) => {
        for (const key of ALIASES[field] ?? [field]) {
            const value = a[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
    };
    const street = [pick('address1'), pick('address2')].filter(Boolean).join(', ');
    const region = [[pick('city'), pick('zip')].filter(Boolean).join(' '), pick('province')].filter(Boolean).join(', ');
    return [pick('company'), street, region, pick('country')].filter(Boolean);
}

/** `INV-26-27/000036` → `INV-26-27-000036.pdf`; a slash is a path separator. */
export function invoicePdfFilename(invoiceNumber: string): string {
    return `${invoiceNumber.replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
}

/** The PDF engine is an ES module; the server is CommonJS, so it is loaded on first use. */
let engine: Promise<typeof ReactPdf> | null = null;
const loadEngine = () => (engine ??= import('@react-pdf/renderer'));

export async function renderInvoicePdf(invoice: InvoiceForPdf): Promise<Buffer> {
    const rp = await loadEngine();
    return rp.renderToBuffer(<InvoiceDocument rp={rp} invoice={invoice} />);
}

function InvoiceDocument({ rp, invoice }: { rp: typeof ReactPdf; invoice: InvoiceForPdf }) {
    const { Document, Page, Text, View } = rp;
    const currency = invoice.currency ?? 'INR';
    // Plain figures in the table and the ladder; the currency is declared once on the document.
    const money = (value: Amount) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value ?? 0));
    const num = (value: Amount) => Number(value ?? 0);
    const date = (value: Date | string) => new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

    const isIntra = invoice.gstType === 'CGST_SGST';
    const isCancelled = invoice.status === 'CANCELLED';
    const discount = num(invoice.totalDiscount);
    const shipping = num(invoice.shippingCharge);
    // Pre-discount value of the goods, so "less discount" has something to be subtracted from.
    const grossValue = num(invoice.subtotal) + discount;

    const seller = addressLines(invoice.sellerAddress);
    const buyer = addressLines(invoice.buyerAddress);
    const dispatch = addressLines(invoice.dispatchAddress);
    // Shown only when the goods left from somewhere other than the registered address.
    const showDispatch = !!invoice.dispatchName && dispatch.length > 0 && dispatch.join('|') !== seller.join('|');

    // Column widths sum to 100, sized for an 8pt figure up to 1,00,00,000.00 in the 515pt content width.
    const col = isIntra
        ? { desc: 29, hsn: 7, qty: 5, unit: 11, disc: 8, taxable: 12, tax: 8, total: 12 }
        : { desc: 33, hsn: 7, qty: 5, unit: 12, disc: 8, taxable: 12, tax: 11, total: 12 };

    const taxCell = (amount: Amount, rate: Amount, width: number) => (
        <View style={[s.cell, { width: `${width}%` }]}>
            <Text style={s.right}>{money(amount)}</Text>
            <Text style={[s.right, s.rate]}>{String(rate ?? 0)}%</Text>
        </View>
    );
    const totalRow = (label: string, value: string, bold = false) => (
        <View style={s.totalRow}>
            <Text style={bold ? s.bold : {}}>{label}</Text>
            <Text style={bold ? s.bold : {}}>{value}</Text>
        </View>
    );

    return (
        <Document title={invoice.invoiceNumber} author={invoice.sellerLegalName}>
            <Page size="A4" style={s.page}>
                {isCancelled && (
                    <View style={s.cancelled}>
                        <Text style={s.cancelledTitle}>CANCELLED</Text>
                        <Text style={s.cancelledText}>
                            This invoice was cancelled{invoice.cancelledAt ? ` on ${date(invoice.cancelledAt)}` : ''} and carries no tax liability.
                        </Text>
                    </View>
                )}

                <View style={s.header}>
                    <View>
                        <Text style={s.h1}>Tax Invoice</Text>
                        <Text style={s.muted}>GST-compliant invoice</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                        <Text style={s.bold}>{invoice.invoiceNumber}</Text>
                        <Text style={s.muted}>{date(invoice.invoiceDate)}</Text>
                        <Text style={s.muted}>FY {invoice.financialYear}</Text>
                    </View>
                </View>

                <View style={s.parties}>
                    <View style={s.party}>
                        <Text style={s.label}>SELLER</Text>
                        <Text style={s.bold}>{invoice.sellerLegalName}</Text>
                        {seller.map((line) => <Text key={line}>{line}</Text>)}
                        <Text>{invoice.sellerStateCode} - {invoice.sellerStateName}</Text>
                        <Text>GSTIN: {invoice.sellerGstin}</Text>
                    </View>
                    <View style={s.party}>
                        <Text style={s.label}>BUYER</Text>
                        <Text style={s.bold}>{invoice.buyerName}</Text>
                        {buyer.map((line) => <Text key={line}>{line}</Text>)}
                        <Text>{invoice.buyerStateCode} - {invoice.buyerStateName}</Text>
                        {invoice.buyerGstin ? <Text>GSTIN: {invoice.buyerGstin}</Text> : <Text style={s.mutedItalic}>Unregistered (B2C)</Text>}
                    </View>
                </View>

                {showDispatch && (
                    <View style={{ marginTop: 10 }}>
                        <Text style={s.label}>DISPATCH FROM</Text>
                        <Text style={s.bold}>{invoice.dispatchName}</Text>
                        {dispatch.map((line) => <Text key={line}>{line}</Text>)}
                    </View>
                )}

                <View style={s.supply}>
                    <Text>
                        <Text style={s.muted}>Place of supply: </Text>
                        {invoice.placeOfSupply} - {invoice.placeOfSupplyName}
                        <Text style={s.muted}>{'    '}Type: </Text>
                        {isIntra ? 'Intra-state (CGST + SGST)' : 'Inter-state (IGST)'}
                        <Text style={s.muted}>{'    '}Reverse charge: </Text>
                        {invoice.reverseCharge ? 'Yes' : 'No'}
                        <Text style={s.muted}>{'    '}Amounts in </Text>
                        {currency}
                    </Text>
                </View>

                <View style={s.table}>
                    {/* `fixed` repeats the header on every page of a long invoice. */}
                    <View style={[s.row, s.head]} fixed>
                        <Text style={[s.cell, { width: `${col.desc}%` }]}>Description</Text>
                        <Text style={[s.cell, { width: `${col.hsn}%` }]}>HSN</Text>
                        <Text style={[s.cell, s.right, { width: `${col.qty}%` }]}>Qty</Text>
                        <Text style={[s.cell, s.right, { width: `${col.unit}%` }]}>Unit</Text>
                        <Text style={[s.cell, s.right, { width: `${col.disc}%` }]}>Disc.</Text>
                        <Text style={[s.cell, s.right, { width: `${col.taxable}%` }]}>Taxable</Text>
                        {isIntra ? (
                            <>
                                <Text style={[s.cell, s.right, { width: `${col.tax}%` }]}>CGST</Text>
                                <Text style={[s.cell, s.right, { width: `${col.tax}%` }]}>SGST</Text>
                            </>
                        ) : (
                            <Text style={[s.cell, s.right, { width: `${col.tax}%` }]}>IGST</Text>
                        )}
                        <Text style={[s.cell, s.right, { width: `${col.total}%` }]}>Total</Text>
                    </View>

                    {invoice.lineItems.map((li) => (
                        // `wrap={false}`: a line never splits across a page break.
                        <View key={li.id} style={s.row} wrap={false}>
                            <Text style={[s.cell, { width: `${col.desc}%` }]}>{li.description}</Text>
                            <Text style={[s.cell, { width: `${col.hsn}%` }]}>{li.hsnCode ?? ''}</Text>
                            <Text style={[s.cell, s.right, { width: `${col.qty}%` }]}>{li.quantity}</Text>
                            <Text style={[s.cell, s.right, { width: `${col.unit}%` }]}>{money(li.unitPrice)}</Text>
                            <Text style={[s.cell, s.right, { width: `${col.disc}%` }]}>{num(li.discount) > 0 ? `-${money(li.discount)}` : '-'}</Text>
                            <Text style={[s.cell, s.right, { width: `${col.taxable}%` }]}>{money(li.taxableValue)}</Text>
                            {isIntra ? (
                                <>
                                    {taxCell(li.cgstAmount, li.cgstRate, col.tax)}
                                    {taxCell(li.sgstAmount, li.sgstRate, col.tax)}
                                </>
                            ) : (
                                taxCell(li.igstAmount, li.igstRate, col.tax)
                            )}
                            <Text style={[s.cell, s.right, s.bold, { width: `${col.total}%` }]}>{money(li.totalAmount)}</Text>
                        </View>
                    ))}
                </View>

                {/* Totals ladder: gross, less discount, taxable, tax, shipping, grand total. */}
                <View style={s.totals} wrap={false}>
                    {discount > 0 && (
                        <>
                            {totalRow('Gross value', money(grossValue))}
                            {totalRow('Less: discount', `-${money(invoice.totalDiscount)}`)}
                        </>
                    )}
                    {totalRow('Taxable value', money(invoice.subtotal))}
                    {isIntra ? (
                        <>
                            {totalRow('CGST', money(invoice.totalCgst))}
                            {totalRow('SGST', money(invoice.totalSgst))}
                        </>
                    ) : (
                        totalRow('IGST', money(invoice.totalIgst))
                    )}
                    {shipping > 0 && totalRow('Shipping (not taxed)', money(invoice.shippingCharge))}
                    <View style={s.grand}>{totalRow('Grand total', money(invoice.grandTotal), true)}</View>
                </View>

                {invoice.notes && (
                    <View style={s.notes}>
                        <Text>
                            <Text style={s.bold}>Notes: </Text>
                            {invoice.notes}
                        </Text>
                    </View>
                )}
            </Page>
        </Document>
    );
}

const s = {
    page: { paddingVertical: 45, paddingHorizontal: 40, fontFamily: 'Helvetica', fontSize: 9, color: '#111827' },
    h1: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
    bold: { fontFamily: 'Helvetica-Bold' },
    muted: { color: '#4b5563' },
    mutedItalic: { color: '#4b5563', fontFamily: 'Helvetica-Oblique' },
    label: { fontSize: 7, color: '#6b7280', letterSpacing: 1, marginBottom: 3 },
    cancelled: { borderWidth: 2, borderColor: '#dc2626', padding: 8, marginBottom: 12, alignItems: 'center' as const },
    cancelledTitle: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#dc2626', letterSpacing: 2 },
    cancelledText: { fontSize: 8, color: '#b91c1c', marginTop: 2 },
    header: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingBottom: 10 },
    parties: { flexDirection: 'row' as const, gap: 24, marginTop: 14 },
    party: { flex: 1 },
    supply: { marginTop: 10, padding: 6, backgroundColor: '#f9fafb', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 3 },
    table: { marginTop: 14, borderTopWidth: 1, borderTopColor: '#e5e7eb', fontSize: 8 },
    row: { flexDirection: 'row' as const, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
    head: { backgroundColor: '#f9fafb', fontFamily: 'Helvetica-Bold' },
    cell: { paddingVertical: 4, paddingHorizontal: 3 },
    right: { textAlign: 'right' as const },
    rate: { fontSize: 7, color: '#6b7280' },
    totals: { marginTop: 14, marginLeft: 'auto' as const, width: 220 },
    totalRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingVertical: 2 },
    grand: { borderTopWidth: 1, borderTopColor: '#e5e7eb', marginTop: 3, paddingTop: 3 },
    notes: { marginTop: 14, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 8, color: '#374151' },
};
