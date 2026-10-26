import type * as ReactPdf from '@react-pdf/renderer';
import type { PosReceipt } from './pos-receipt.service';

/**
 * The till's bill as a PDF: the file a sale's WhatsApp bill carries when the
 * sale has no GST invoice (one that has carries the invoice's own PDF).
 *
 * Mirrors the public bill page (client routes/public/bill.tsx) section for
 * section, from the same receipt, without the customer's number. Amounts
 * print as plain figures with the currency named once: the built-in PDF
 * fonts carry no rupee glyph.
 */

const METHOD: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };

/** `#M1042` → `Bill-M1042.pdf`; a slash is a path separator and `#` cuts a link short. */
export function billPdfFilename(number: string): string {
    return `Bill-${number.replace(/[\\/:*?"<>|#]+/g, '-').replace(/^-+|-+$/g, '')}.pdf`;
}

/** The PDF engine is an ES module; the server is CommonJS, so it is loaded on first use. */
let engine: Promise<typeof ReactPdf> | null = null;
const loadEngine = () => (engine ??= import('@react-pdf/renderer'));

export async function renderBillPdf(receipt: PosReceipt): Promise<Buffer> {
    const rp = await loadEngine();
    return rp.renderToBuffer(<BillDocument rp={rp} r={receipt} />);
}

function BillDocument({ rp, r }: { rp: typeof ReactPdf; r: PosReceipt }) {
    const { Document, Page, Text, View } = rp;
    const money = (value: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    const date = (value: string) => new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

    const kind = r.invoice ? 'Tax invoice' : r.balanceDue > 0 ? 'Bill' : 'Receipt';
    const number = r.invoice?.number ?? r.order.name;
    const igst = r.invoice?.gstType === 'INTER' || r.totals.igst > 0;
    const taxed = r.totals.cgst + r.totals.sgst + r.totals.igst > 0;
    const billedTo = r.customer && (r.customer.name || r.customer.gstin) ? r.customer : null;
    const contact = [r.store.phone && `Phone ${r.store.phone}`, r.store.gstin && `GSTIN ${r.store.gstin}`].filter(Boolean).join('   ·   ');
    const billedBy = r.order.staffName
        ? `Billed by ${r.order.staffName}${r.order.storeName && r.order.storeName !== r.store.name ? ` at ${r.order.storeName}` : ''}`
        : null;

    // Column widths sum to 100, sized for an 8pt figure up to 1,00,00,000.00 in the 515pt content width.
    const col = { item: 46, qty: 8, price: 16, disc: 14, amount: 16 };
    const tax = igst ? { rate: 25, taxable: 45, igst: 30 } : { rate: 16, taxable: 28, cgst: 28, sgst: 28 };

    const meta = (label: string, value: string, extra?: string | null) => (
        <View style={s.metaItem}>
            <Text style={s.label}>{label}</Text>
            <Text style={s.bold}>{value}</Text>
            {extra && <Text>{extra}</Text>}
        </View>
    );
    const totalRow = (label: string, value: string, bold = false) => (
        <View style={s.totalRow}>
            <Text style={bold ? s.bold : {}}>{label}</Text>
            <Text style={bold ? s.bold : {}}>{value}</Text>
        </View>
    );

    return (
        <Document title={`${kind} ${number}`} author={r.store.name}>
            <Page size="A4" style={s.page}>
                <View style={s.header}>
                    <View style={s.store}>
                        <Text style={s.h1}>{r.store.name}</Text>
                        {r.store.address && <Text style={s.muted}>{r.store.address}</Text>}
                        {contact && <Text style={s.muted}>{contact}</Text>}
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                        <Text style={s.label}>{kind.toUpperCase()}</Text>
                        <Text style={s.bold}>{number}</Text>
                        <Text style={s.muted}>{date(r.invoice?.date ?? r.order.createdAt)}</Text>
                    </View>
                </View>

                <View style={s.meta}>
                    {r.invoice && meta('INVOICE NUMBER', r.invoice.number)}
                    {meta('BILL NUMBER', r.order.name)}
                    {r.invoice?.placeOfSupply && meta('PLACE OF SUPPLY', r.invoice.placeOfSupply)}
                    {billedTo && meta('BILLED TO', billedTo.name ?? `GSTIN ${billedTo.gstin}`, billedTo.name && billedTo.gstin ? `GSTIN ${billedTo.gstin}` : null)}
                </View>

                <Text style={[s.muted, s.currency]}>Amounts in INR</Text>
                <View style={s.table}>
                    {/* `fixed` repeats the header on every page of a long bill. */}
                    <View style={[s.row, s.head]} fixed>
                        <Text style={[s.cell, { width: `${col.item}%` }]}>Item</Text>
                        <Text style={[s.cell, s.right, { width: `${col.qty}%` }]}>Qty</Text>
                        <Text style={[s.cell, s.right, { width: `${col.price}%` }]}>Price</Text>
                        <Text style={[s.cell, s.right, { width: `${col.disc}%` }]}>Disc.</Text>
                        <Text style={[s.cell, s.right, { width: `${col.amount}%` }]}>Amount</Text>
                    </View>
                    {r.lines.map((l, i) => (
                        // `wrap={false}`: a line never splits across a page break.
                        <View key={i} style={s.row} wrap={false}>
                            <View style={[s.cell, { width: `${col.item}%` }]}>
                                <Text>{l.title}</Text>
                                {l.variantTitle && <Text style={s.small}>{l.variantTitle}</Text>}
                                {(l.hsn || l.gstRate != null) && (
                                    <Text style={s.small}>{[l.hsn && `HSN ${l.hsn}`, l.gstRate != null && `GST ${l.gstRate}%`].filter(Boolean).join('   ·   ')}</Text>
                                )}
                            </View>
                            <Text style={[s.cell, s.right, { width: `${col.qty}%` }]}>{l.quantity}</Text>
                            <Text style={[s.cell, s.right, { width: `${col.price}%` }]}>{money(l.unitPrice)}</Text>
                            <Text style={[s.cell, s.right, { width: `${col.disc}%` }]}>{l.discount > 0 ? `-${money(l.discount)}` : '-'}</Text>
                            <Text style={[s.cell, s.right, s.bold, { width: `${col.amount}%` }]}>{money(l.total)}</Text>
                        </View>
                    ))}
                </View>

                <View style={s.totals} wrap={false}>
                    {totalRow('Subtotal', money(r.totals.subtotal))}
                    {r.totals.discount > 0 && totalRow('Discount', `-${money(r.totals.discount)}`)}
                    {r.invoice && totalRow('Taxable value', money(r.totals.taxable))}
                    {igst ? (
                        r.totals.igst > 0 && totalRow('IGST', money(r.totals.igst))
                    ) : (
                        <>
                            {r.totals.cgst > 0 && totalRow('CGST', money(r.totals.cgst))}
                            {r.totals.sgst > 0 && totalRow('SGST', money(r.totals.sgst))}
                        </>
                    )}
                    {r.totals.roundOff !== 0 && totalRow('Round-off', `${r.totals.roundOff > 0 ? '+' : '-'}${money(Math.abs(r.totals.roundOff))}`)}
                    <View style={s.grand}>{totalRow('Total', money(r.totals.payable), true)}</View>
                    {taxed && <Text style={s.muted}>The total includes GST.</Text>}
                </View>

                {r.gstSummary.length > 0 && (
                    <View style={s.section} wrap={false}>
                        <Text style={s.label}>GST SUMMARY</Text>
                        <View style={s.summary}>
                            <View style={[s.row, s.head]}>
                                <Text style={[s.cell, { width: `${tax.rate}%` }]}>Rate</Text>
                                <Text style={[s.cell, s.right, { width: `${tax.taxable}%` }]}>Taxable</Text>
                                {igst ? (
                                    <Text style={[s.cell, s.right, { width: `${tax.igst}%` }]}>IGST</Text>
                                ) : (
                                    <>
                                        <Text style={[s.cell, s.right, { width: `${tax.cgst}%` }]}>CGST</Text>
                                        <Text style={[s.cell, s.right, { width: `${tax.sgst}%` }]}>SGST</Text>
                                    </>
                                )}
                            </View>
                            {r.gstSummary.map((g) => (
                                <View key={g.rate} style={s.row}>
                                    <Text style={[s.cell, { width: `${tax.rate}%` }]}>{g.rate}%</Text>
                                    <Text style={[s.cell, s.right, { width: `${tax.taxable}%` }]}>{money(g.taxable)}</Text>
                                    {igst ? (
                                        <Text style={[s.cell, s.right, { width: `${tax.igst}%` }]}>{money(g.igst)}</Text>
                                    ) : (
                                        <>
                                            <Text style={[s.cell, s.right, { width: `${tax.cgst}%` }]}>{money(g.cgst)}</Text>
                                            <Text style={[s.cell, s.right, { width: `${tax.sgst}%` }]}>{money(g.sgst)}</Text>
                                        </>
                                    )}
                                </View>
                            ))}
                        </View>
                    </View>
                )}

                <View style={s.section} wrap={false}>
                    <Text style={s.label}>PAYMENT</Text>
                    <View style={s.payments}>
                        {r.payments.length === 0 && <Text style={s.muted}>Not paid yet.</Text>}
                        {r.payments.map((p, i) => (
                            <View key={i} style={s.payment}>
                                {totalRow(`Paid by ${METHOD[p.method] ?? p.method}`, money(p.amount))}
                                {p.method === 'CASH' && p.tendered != null && p.tendered > p.amount && (
                                    <Text style={s.muted}>Received {money(p.tendered)}, change {money(p.change ?? Math.round((p.tendered - p.amount) * 100) / 100)}</Text>
                                )}
                                {p.reference && <Text style={s.muted}>Reference {p.reference}</Text>}
                            </View>
                        ))}
                        {r.balanceDue > 0 && <View style={s.due}>{totalRow('Balance due', money(r.balanceDue), true)}</View>}
                    </View>
                </View>

                <View style={s.footer} wrap={false}>
                    {r.footer && <Text style={s.footerText}>{r.footer}</Text>}
                    {billedBy && <Text style={s.muted}>{billedBy}</Text>}
                    <Text style={[s.bold, s.thanks]}>Thank you for shopping with us.</Text>
                </View>
            </Page>
        </Document>
    );
}

const s = {
    page: { paddingVertical: 45, paddingHorizontal: 40, fontFamily: 'Helvetica', fontSize: 9, color: '#111827' },
    h1: { fontSize: 16, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
    bold: { fontFamily: 'Helvetica-Bold' },
    muted: { color: '#4b5563' },
    small: { fontSize: 7, color: '#6b7280', marginTop: 1 },
    label: { fontSize: 7, color: '#6b7280', letterSpacing: 1, marginBottom: 3 },
    header: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, gap: 24, borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingBottom: 10 },
    store: { flex: 1 },
    meta: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 24, marginTop: 14 },
    metaItem: { minWidth: 90 },
    currency: { marginTop: 14, textAlign: 'right' as const, fontSize: 7 },
    table: { marginTop: 3, borderTopWidth: 1, borderTopColor: '#e5e7eb', fontSize: 8 },
    row: { flexDirection: 'row' as const, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
    head: { backgroundColor: '#f9fafb', fontFamily: 'Helvetica-Bold' },
    cell: { paddingVertical: 4, paddingHorizontal: 3 },
    right: { textAlign: 'right' as const },
    totals: { marginTop: 14, marginLeft: 'auto' as const, width: 220 },
    totalRow: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingVertical: 2 },
    grand: { borderTopWidth: 1, borderTopColor: '#e5e7eb', marginTop: 3, paddingTop: 3, fontSize: 11 },
    section: { marginTop: 16 },
    summary: { width: 300, borderTopWidth: 1, borderTopColor: '#e5e7eb', fontSize: 8 },
    payments: { width: 300 },
    payment: { marginBottom: 2 },
    due: { marginTop: 4, padding: 4, backgroundColor: '#fef3c7', color: '#92400e' },
    footer: { marginTop: 20, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 10, alignItems: 'center' as const, gap: 3 },
    footerText: { textAlign: 'center' as const },
    thanks: { marginTop: 4 },
};
