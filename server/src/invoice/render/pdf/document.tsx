import type * as ReactPdf from '@react-pdf/renderer';
import { Fragment, type ReactNode } from 'react';
import { PDF_FONT_FAMILY } from '../../../pdf/fonts';
import type { DocField, DocLine, DocumentModel } from '../document-model';
import { formatAmount, formatMoney } from '../money';
import {
    breakWordsWiderThan,
    CELL_PAD,
    CONTENT_WIDTH,
    type Column,
    DETAIL_GAP,
    discountText,
    FOOTER_BOTTOM,
    linesAmount,
    type Measure,
    PAGE,
    PAGE_NUMBER_WIDTH,
    quantityText,
    rateText,
    SIGNATORY_WIDTH,
    taxColumns,
    taxLabel,
    TYPE,
} from './layout';
import { CHIP, GRID, INK, MUTED, type Palette, WATERMARK } from './theme';

type Style = ReactPdf.Styles[string];

/** What the renderer worked out before drawing: sizes from the font and the images, and the QR. */
export interface DocumentPlan {
    columns: Column[];
    details: Array<{ fields: DocField[]; labelWidth: number }>;
    footer: { lines: string[]; pageBottom: number };
    /** The logo's size in points, within 140 × 40; null draws the trading name instead. */
    logo: { width: number; height: number } | null;
    /** The signature's size in points, within 96 × 30. */
    signature: { width: number; height: number } | null;
    /** `payment.upiUri` as a PNG data URL. */
    qr: string | null;
    /** The subtitle's measure, so its two lines break evenly. */
    subtitleWidth: number;
    palette: Palette;
    /** Text widths in the document's font, for words too wide for their box. */
    measure: Measure;
    /** Room the table needs at the foot of a page before it may start there: its margin, header and first row. */
    tableLead: number;
    /** Whether these blocks fit on one page, and so may be kept whole. */
    keepTogether: { closing: boolean; payment: boolean };
}

/** The primitives every section draws with. */
interface Ui {
    Text: typeof ReactPdf.Text;
    View: typeof ReactPdf.View;
    Image: typeof ReactPdf.Image;
}

interface Ctx {
    ui: Ui;
    model: DocumentModel;
    plan: DocumentPlan;
}

/**
 * The A4 document, top to bottom as report 4.1 lays it out: every-page
 * elements, header, details, parties, items, amount in words and totals, tax
 * summary, payment, terms and signatory, notes, footer. It draws what the
 * model says and decides nothing about tax.
 */
export function DocumentPdf({ rp, model, plan }: { rp: typeof ReactPdf; model: DocumentModel; plan: DocumentPlan }) {
    const { Document, Page, Text, View, Image } = rp;
    const ctx: Ctx = { ui: { Text, View, Image }, model, plan };
    const brand = model.seller.tradeName ?? model.seller.legalName;
    return (
        <Document title={`${model.title} ${model.documentNumber}`} author={model.seller.legalName} creator="Collabo" producer="Collabo" language="en-IN">
            <Page size="A4" style={{ ...s.page, paddingBottom: plan.footer.pageBottom }}>
                {/*
                 * Every-page elements are fixed, absolutely placed children of Page. The page
                 * number stands alone and is placed from the top: in react-pdf 4.9 a dynamic
                 * text placed by `bottom`, or a footer holding one, lands off the page or
                 * vanishes (report 4.6). The footer's lines, all static, share one View so
                 * it grows upward when they wrap.
                 */}
                {model.cancelled && (
                    <Text fixed style={s.watermark}>
                        CANCELLED
                    </Text>
                )}
                {plan.palette.bar && <View fixed style={{ ...s.bar, backgroundColor: plan.palette.bar }} />}
                {model.copyMark && (
                    <Text fixed style={s.copyMark}>
                        {model.copyMark}
                    </Text>
                )}
                <Text fixed style={s.strip} render={({ pageNumber }) => (pageNumber > 1 ? `${brand}  ·  ${model.title} ${model.documentNumber}  ·  continued` : '')} />
                {/* Declared before the content: should a block ever overflow its page, react-pdf drops the fixed nodes declared after it. */}
                {plan.footer.lines.length > 0 && (
                    <View fixed style={s.footer}>
                        {plan.footer.lines.map((line, i) => (
                            <Text key={i} hyphenationCallback={wrapIn(ctx, CONTENT_WIDTH - PAGE_NUMBER_WIDTH, TYPE.footer)}>
                                {line}
                            </Text>
                        ))}
                    </View>
                )}
                <Text fixed style={s.pageNumber} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />

                {header(ctx)}
                {details(ctx)}
                {reference(ctx)}
                {parties(ctx)}
                {/* Moves the table to the next page rather than leave its header alone at the foot of this one. */}
                <View minPresenceAhead={plan.tableLead} />
                {itemTable(ctx)}
                {wordsAndTotals(ctx)}
                {taxSummary(ctx)}
                {payment(ctx)}
                {closing(ctx)}
                {notes(ctx)}
                {!model.notes && !hasClosing(model) && brandLine(ctx)}
            </Page>
        </Document>
    );
}

function label({ ui: { Text } }: Ctx, text: string, extra?: Style) {
    return <Text style={{ ...s.label, ...extra }}>{text.toUpperCase()}</Text>;
}

/**
 * For text the merchant or buyer typed: a word wider than `room` (its box and
 * any free gap beside it, up to the next thing drawn) breaks, rather than run
 * over that next thing.
 */
function wrapIn({ plan }: Ctx, room: number, size: number = TYPE.body, bold = false) {
    return breakWordsWiderThan(room, plan.measure, size, bold);
}

/** The seller's column: the content width less the status block and the gap between them. */
const SELLER_WIDTH = CONTENT_WIDTH - 210 - 16;

/** A space that never breaks a line: holds an ID's label to its value, and a phone number together. */
const NBSP = '\u00a0';

/**
 * IDs as "PAN ABCDE1234F  ·  CIN U18101…", each pair held together, and the
 * dot kept at the end of a line, so a line only ever breaks between two IDs.
 */
function idsText(ids: DocField[]): string {
    return ids.map((id) => `${id.label} ${id.value}`.replaceAll(' ', NBSP)).join(`${NBSP}${NBSP}·${NBSP} `);
}

/** "phone · email · website" that wraps between its parts, never inside a phone number. */
function contactText(line: string): string {
    return line
        .split(' · ')
        .map((part) => part.replaceAll(' ', NBSP))
        .join(`${NBSP}· `);
}

function header(ctx: Ctx) {
    const {
        ui: { Image, Text, View },
        model: { seller, status, title, subtitle, currency },
        plan,
    } = ctx;
    const logo = seller.logo && plan.logo ? { image: seller.logo, size: plan.logo } : null;
    // A wide logo is a wordmark already; a squarish one is a mark, set beside the trading name like the mock.
    const beside = logo && seller.tradeName && logo.size.width / logo.size.height < 2.2 ? seller.tradeName : null;
    const wordmark = logo ? beside : (seller.tradeName ?? seller.legalName);
    const legalIsWordmark = !logo && !seller.tradeName;
    const tone = status.chip ? CHIP[status.chip.tone] : null;
    return (
        <View style={s.header}>
            <View style={s.sellerBlock}>
                {(logo || wordmark) && (
                    <View style={s.brand}>
                        {logo && <Image src={logo.image} style={{ ...logo.size, marginRight: wordmark ? 8 : 0 }} />}
                        {wordmark && (
                            <Text style={s.wordmark} hyphenationCallback={wrapIn(ctx, SELLER_WIDTH - (logo ? logo.size.width + 8 : 0) + 14, 17, true)}>
                                {wordmark}
                            </Text>
                        )}
                    </View>
                )}
                {!legalIsWordmark && (
                    <Text style={s.legalName} hyphenationCallback={wrapIn(ctx, SELLER_WIDTH + 14, 9.5, true)}>
                        {seller.legalName}
                    </Text>
                )}
                {seller.addressLines.map((line, i) => (
                    <Text key={i} style={s.muted} hyphenationCallback={wrapIn(ctx, SELLER_WIDTH + 14)}>
                        {line}
                    </Text>
                ))}
                {seller.contactLine && (
                    <Text style={s.muted} hyphenationCallback={wrapIn(ctx, SELLER_WIDTH + 14)}>
                        {contactText(seller.contactLine)}
                    </Text>
                )}
                {(seller.gstin || seller.state) && (
                    <Text style={{ marginTop: 3 }}>
                        {seller.gstin && <Text style={s.bold}>GSTIN {seller.gstin}</Text>}
                        {seller.gstin && seller.state ? '  ·  ' : ''}
                        {seller.state ? `State: ${seller.state}` : ''}
                    </Text>
                )}
                {seller.ids.length > 0 && <Text>{idsText(seller.ids)}</Text>}
                {seller.dispatchFrom && (
                    <Text style={{ ...s.muted, marginTop: 2 }} hyphenationCallback={wrapIn(ctx, SELLER_WIDTH + 14)}>
                        {seller.dispatchFrom}
                    </Text>
                )}
            </View>
            <View style={s.statusBlock}>
                <Text style={{ ...s.title, color: plan.palette.title }}>{title}</Text>
                {subtitle && <Text style={{ ...s.subtitle, width: plan.subtitleWidth }}>{subtitle}</Text>}
                {status.chip && tone && <Text style={{ ...s.chip, backgroundColor: tone.fill, color: tone.text }}>{status.chip.text}</Text>}
                {status.line && <Text style={s.statusLine}>{status.line}</Text>}
                <Text style={{ ...s.statusAmount, marginTop: status.line ? 0 : 6 }}>{formatMoney(status.amount, currency)}</Text>
                {status.note && <Text style={s.statusLine}>{status.note}</Text>}
            </View>
        </View>
    );
}

function details(ctx: Ctx) {
    const {
        ui: { Text, View },
        plan,
    } = ctx;
    if (!plan.details.length) return null;
    return (
        <View style={{ ...s.details, borderColor: plan.palette.rule }}>
            {plan.details.map((column, i) => (
                <View key={i} style={{ flex: 1, paddingRight: DETAIL_GAP }}>
                    {column.fields.map((field, j) => (
                        <View key={j} style={s.detailRow}>
                            <Text style={{ width: column.labelWidth, color: MUTED }}>{field.label}</Text>
                            <Text style={s.detailValue} hyphenationCallback={wrapIn(ctx, CONTENT_WIDTH / plan.details.length - column.labelWidth - 2, TYPE.body, true)}>
                                {field.value}
                            </Text>
                        </View>
                    ))}
                </View>
            ))}
        </View>
    );
}

/** A credit note's "Against invoice … dated …" and its reason, set apart under the details. */
function reference(ctx: Ctx) {
    const {
        ui: { Text, View },
        model,
        plan,
    } = ctx;
    if (!model.reference.length) return null;
    return (
        <View style={{ ...s.reference, borderLeftColor: plan.palette.grid ? INK : plan.palette.headRule }}>
            {model.reference.map((line, i) => (
                <Text key={i} style={i === 0 ? s.bold : undefined} hyphenationCallback={wrapIn(ctx, CONTENT_WIDTH - 12, TYPE.body, i === 0)}>
                    {line}
                </Text>
            ))}
        </View>
    );
}

function parties(ctx: Ctx) {
    const {
        ui: { Text, View },
        model,
        plan,
    } = ctx;
    if (!model.parties.length) return null;
    const boxed = plan.palette.grid;
    const gap = boxed ? 8 : 16;
    const width = (CONTENT_WIDTH - gap * (model.parties.length - 1)) / model.parties.length - (boxed ? 13 : 0);
    return (
        <View style={s.parties}>
            {model.parties.map((party, i) => (
                <View key={i} style={{ flex: 1, marginLeft: i ? gap : 0, ...(boxed ? s.partyBox : {}) }}>
                    {label(ctx, party.heading)}
                    <Text style={s.partyName} hyphenationCallback={wrapIn(ctx, width, 9, true)}>
                        {party.name}
                    </Text>
                    {party.lines.map((line, j) => (
                        <Text key={j} hyphenationCallback={wrapIn(ctx, width)}>
                            {line}
                        </Text>
                    ))}
                    {party.state && <Text>State: {party.state}</Text>}
                    {party.gstin && <Text style={s.bold}>GSTIN {party.gstin}</Text>}
                </View>
            ))}
        </View>
    );
}

function itemTable(ctx: Ctx) {
    const {
        ui: { Text, View },
        model,
        plan: { columns, palette },
    } = ctx;
    const { lines, totals } = model;
    const grid = palette.grid;
    const cell = (column: Column, extra?: Style): Style => ({
        width: column.width,
        paddingVertical: 3,
        paddingHorizontal: CELL_PAD,
        textAlign: column.align,
        ...(grid ? { borderRightWidth: 0.5, borderRightColor: GRID } : {}),
        ...extra,
    });
    const row: Style = { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: palette.rule, ...(grid ? { borderLeftWidth: 0.5, borderLeftColor: GRID } : {}) };

    const lineCell = (column: Column, line: DocLine) => {
        switch (column.key) {
            case 'index':
                return <Text style={cell(column, { color: MUTED })}>{line.index}</Text>;
            case 'item':
                return (
                    <View style={cell(column)}>
                        <Text style={s.bold} hyphenationCallback={wrapIn(ctx, column.width - CELL_PAD, TYPE.body, true)}>
                            {line.name}
                        </Text>
                        {line.detail && (
                            <Text style={s.detail} hyphenationCallback={wrapIn(ctx, column.width - CELL_PAD, TYPE.detail)}>
                                {line.detail}
                            </Text>
                        )}
                    </View>
                );
            case 'hsn':
                return <Text style={cell(column)}>{line.hsn ?? ''}</Text>;
            case 'quantity':
                return <Text style={cell(column)}>{line.quantity}</Text>;
            case 'rate':
                return <Text style={cell(column)}>{formatAmount(line.rate)}</Text>;
            case 'discount':
                return <Text style={cell(column)}>{discountText(line.discount)}</Text>;
            case 'taxable':
                return <Text style={cell(column)}>{formatAmount(line.taxable)}</Text>;
            case 'cgst':
            case 'sgst':
            case 'igst': {
                const tax = line[column.key];
                if (!tax) return <Text style={cell(column)}>–</Text>;
                return (
                    <View style={cell(column)}>
                        <Text>{formatAmount(tax.amount)}</Text>
                        <Text style={s.detail}>{rateText(tax.rate)}</Text>
                    </View>
                );
            }
            case 'amount':
                return <Text style={cell(column, { fontWeight: 700 })}>{formatAmount(line.amount)}</Text>;
        }
    };
    const totalCell = (column: Column): string => {
        switch (column.key) {
            case 'item':
                return 'Total';
            case 'quantity':
                return totals.quantity === null ? '' : quantityText(totals.quantity);
            case 'discount':
                return discountText(totals.discount);
            case 'taxable':
                return formatAmount(totals.taxable);
            case 'cgst':
            case 'sgst':
            case 'igst':
                return formatAmount(totals[column.key]);
            case 'amount':
                return formatAmount(linesAmount(lines));
            default:
                return '';
        }
    };
    const itemRow = (line: DocLine) => (
        <View key={line.index} wrap={false} style={row}>
            {columns.map((column) => (
                <Fragment key={column.key}>{lineCell(column, line)}</Fragment>
            ))}
        </View>
    );
    const last = lines[lines.length - 1];
    return (
        <View style={s.table}>
            {/* `fixed` inside the table: the header repeats on every page the table reaches. */}
            <View fixed style={{ ...row, backgroundColor: palette.headFill, borderBottomWidth: 1, borderBottomColor: palette.headRule, ...(grid ? { borderTopWidth: 0.5, borderTopColor: GRID } : {}) }}>
                {/* Labels sit on the rule, so one-line labels line up with the last line of "Taxable value". */}
                {columns.map((column) => (
                    <View key={column.key} style={cell(column, { justifyContent: 'flex-end' })}>
                        <Text style={{ ...s.th, color: palette.headText, textAlign: column.align }}>{column.label.toUpperCase()}</Text>
                    </View>
                ))}
            </View>
            {lines.slice(0, -1).map(itemRow)}
            {/* The last row and the Total row move together, so a page never opens on the Total alone. */}
            <View wrap={false}>
                {last && itemRow(last)}
                <View style={{ ...row, borderBottomWidth: 1, borderBottomColor: grid ? INK : GRID }}>
                    {columns.map((column) => (
                        <Text key={column.key} style={cell(column, { fontWeight: 700 })}>
                            {totalCell(column)}
                        </Text>
                    ))}
                </View>
            </View>
        </View>
    );
}

function wordsAndTotals(ctx: Ctx) {
    const {
        ui: { Text, View },
        model,
        plan: { palette },
    } = ctx;
    const { totals, currency } = model;
    const rows: Array<[string, string]> = [];
    if (totals.discount) {
        rows.push(['Item value (before discount)', formatAmount(totals.itemValue)], ['Less: discount', formatAmount(-totals.discount)]);
    } else if (!model.taxHeads && (totals.charges.length || totals.roundOff)) {
        // With no tax rows to start from, the ladder opens on the item value whenever something is added to it, so it adds up.
        rows.push(['Item value', formatAmount(totals.itemValue)]);
    }
    if (model.taxHeads) {
        rows.push(['Taxable value', formatAmount(totals.taxable)]);
        for (const key of taxColumns(model)) rows.push([taxLabel(model, key), formatAmount(totals[key])]);
    }
    for (const charge of totals.charges) rows.push([charge.label, formatAmount(charge.amount)]);
    if (totals.roundOff) rows.push(['Round off', `${totals.roundOff > 0 ? '+' : ''}${formatAmount(totals.roundOff)}`]);

    const ladderRow = ([name, value]: [string, string], key: string, bold = false) => (
        <View key={key} style={s.ladderRow}>
            <Text style={{ ...s.ladderLabel, ...(bold ? s.bold : {}) }}>{name}</Text>
            <Text style={bold ? s.bold : {}}>{value}</Text>
        </View>
    );
    return (
        <View wrap={false} style={s.wordsAndTotals}>
            <View style={s.words}>
                {model.amountInWords && (
                    <>
                        {label(ctx, 'Amount in words')}
                        <Text style={s.bold}>{model.amountInWords}</Text>
                    </>
                )}
            </View>
            <View style={s.ladder}>
                {rows.map((entry, i) => ladderRow(entry, `row${i}`))}
                <View style={{ ...s.grand, backgroundColor: palette.totalFill, ...(palette.totalBorder ? { borderWidth: 0.75, borderColor: palette.totalBorder } : {}) }}>
                    <Text style={s.grandLabel}>{totals.grandLabel}</Text>
                    <Text style={s.grandAmount}>{formatMoney(totals.grandTotal, currency)}</Text>
                </View>
                {totals.paid !== null && ladderRow(['Amount paid', formatAmount(totals.paid)], 'paid')}
                {totals.balanceDue !== null && ladderRow(['Balance due', formatMoney(totals.balanceDue, currency)], 'due', true)}
            </View>
        </View>
    );
}

function taxSummary(ctx: Ctx) {
    const {
        ui: { Text, View },
        model,
        plan: { palette },
    } = ctx;
    const summary = model.taxSummary;
    if (!summary || !model.taxHeads) return null;
    const taxes = taxColumns(model);
    // HSN and rate keep fixed shares; the figures split the rest evenly.
    const share = 72 / (taxes.length + 2);
    const columns: Array<{ label: string; width: string; left?: boolean }> = [
        { label: 'HSN', width: '16%', left: true },
        { label: 'GST rate', width: '12%' },
        { label: 'Taxable value', width: `${share}%` },
        ...taxes.map((key) => ({ label: taxLabel(model, key), width: `${share}%` })),
        { label: 'Total tax', width: `${share}%` },
    ];
    const grid = palette.grid;
    const row: Style = { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: palette.rule, ...(grid ? { borderLeftWidth: 0.5, borderLeftColor: GRID } : {}) };
    const cell = (i: number, extra?: Style): Style => ({
        width: columns[i].width as Style['width'],
        paddingVertical: 2,
        paddingHorizontal: CELL_PAD,
        textAlign: columns[i].left ? 'left' : 'right',
        ...(grid ? { borderRightWidth: 0.5, borderRightColor: GRID } : {}),
        ...extra,
    });
    const line = (values: string[], key: string, bold = false) => (
        <View key={key} wrap={false} style={row}>
            {values.map((value, i) => (
                <Text key={i} style={cell(i, bold ? { fontWeight: 700 } : undefined)}>
                    {value}
                </Text>
            ))}
        </View>
    );
    return (
        <>
            {/* Keeps the heading, the column header and a first row together. */}
            <View minPresenceAhead={48} />
            <View style={s.summary}>
                {label(ctx, 'Tax summary (HSN-wise)')}
                {/* Repeats if the summary runs onto the next page; its rows may split between pages, never within one. */}
                <View fixed style={{ ...row, backgroundColor: palette.headFill, ...(grid ? { borderTopWidth: 0.5, borderTopColor: GRID, borderBottomColor: INK } : {}) }}>
                    {columns.map((column, i) => (
                        <View key={i} style={cell(i, { justifyContent: 'flex-end' })}>
                            <Text style={{ ...s.th, fontSize: 6.4, color: palette.headText, textAlign: column.left ? 'left' : 'right' }}>{column.label.toUpperCase()}</Text>
                        </View>
                    ))}
                </View>
                {summary.rows.map((r, i) =>
                    line([r.hsn, `${Number(r.rate.toFixed(3))}%`, formatAmount(r.taxable), ...taxes.map((key) => formatAmount(r[key])), formatAmount(r.totalTax)], `r${i}`),
                )}
                {line(['Total', '', formatAmount(summary.total.taxable), ...taxes.map((key) => formatAmount(summary.total[key])), formatAmount(summary.total.totalTax)], 'total', true)}
            </View>
        </>
    );
}

function payment(ctx: Ctx) {
    const {
        ui: { Image, Text, View },
        model,
        plan,
    } = ctx;
    const p = model.payment;
    if (!p) return null;
    if (p.kind === 'received') {
        return (
            <View wrap={!plan.keepTogether.payment} style={s.box}>
                {label(ctx, 'Payment received')}
                {p.lines.map((line, i) => (
                    <Text key={i} hyphenationCallback={wrapIn(ctx, CONTENT_WIDTH - 11)}>
                        {line}
                    </Text>
                ))}
            </View>
        );
    }
    if (!plan.qr) {
        return (
            <View wrap={false} style={{ ...s.box, flexDirection: 'row', alignItems: 'center' }}>
                {label(ctx, 'Payment due', { marginBottom: 0, marginRight: 10 })}
                <Text style={s.bold}>{formatMoney(p.amount, model.currency)}</Text>
            </View>
        );
    }
    return (
        <View wrap={false} style={{ ...s.box, flexDirection: 'row', alignItems: 'center' }}>
            <Image src={plan.qr} style={s.qr} />
            <View style={{ flex: 1, paddingLeft: 10 }}>
                {label(ctx, 'Pay by UPI')}
                <Text style={s.scanToPay}>Scan to pay {formatMoney(p.amount, model.currency)}</Text>
                {p.upiId && (
                    <Text style={s.muted}>
                        UPI ID <Text style={{ color: INK }}>{p.upiId}</Text>
                        {'  ·  '}any UPI app
                    </Text>
                )}
            </View>
        </View>
    );
}

/**
 * Terms, returns, declaration and the signatory (and the brand's closing line
 * when there are no notes), kept on one page so the signatory lands on the
 * last: unless they are taller than a page, which react-pdf cannot draw whole.
 */
const hasClosing = (model: DocumentModel) => model.terms.length > 0 || !!model.returns || !!model.declaration || !!model.signatory;

/**
 * The brand's closing line, e.g. "Thank you for shopping with us.", carried
 * at the end of whatever block ends the document, so it never lands on a page
 * of its own.
 */
function brandLine({ ui: { Text }, model, plan }: Ctx) {
    const note = model.footer.note;
    return note ? <Text style={{ ...s.footerNote, color: plan.palette.title }}>{note}</Text> : null;
}

function closing(ctx: Ctx) {
    const {
        ui: { Image, Text, View },
        model,
        plan,
    } = ctx;
    const { terms, returns, declaration, signatory } = model;
    if (!hasClosing(model)) return null;
    const leftWidth = CONTENT_WIDTH - (signatory ? SIGNATORY_WIDTH : 0) - 14;
    const part = (heading: string, body: ReactNode, first: boolean) => (
        <View style={{ marginTop: first ? 0 : 6 }}>
            {label(ctx, heading)}
            {body}
        </View>
    );
    const blocks: ReactNode[] = [];
    if (terms.length) {
        blocks.push(
            part(
                'Terms & conditions',
                terms.map((term, i) => (
                    <View key={i} style={{ flexDirection: 'row' }}>
                        <Text style={{ ...s.small, width: 12 }}>{i + 1}.</Text>
                        <Text style={{ ...s.small, flex: 1 }} hyphenationCallback={wrapIn(ctx, leftWidth, TYPE.small)}>
                            {term}
                        </Text>
                    </View>
                )),
                true,
            ),
        );
    }
    const paragraph = (text: string) => (
        <Text style={s.small} hyphenationCallback={wrapIn(ctx, leftWidth + 12, TYPE.small)}>
            {text}
        </Text>
    );
    if (returns) blocks.push(part('Returns & exchanges', paragraph(returns), !blocks.length));
    if (declaration) blocks.push(part('Declaration', paragraph(declaration), !blocks.length));
    return (
        <View wrap={!plan.keepTogether.closing}>
            <View style={{ ...s.closing, borderTopColor: plan.palette.rule }}>
                <View style={{ flex: 1, paddingRight: 14 }}>
                    {blocks.map((block, i) => (
                        <View key={i}>{block}</View>
                    ))}
                </View>
                {signatory && (
                    <View wrap={false} style={s.signatory}>
                        <Text style={s.forName}>{signatory.forName}</Text>
                        {/* The uploaded signature, or room to sign by hand. */}
                        <View style={{ height: signatory.image ? 36 : 42, justifyContent: 'flex-end', alignItems: 'flex-end', paddingBottom: 2 }}>
                            {signatory.image && plan.signature && <Image src={signatory.image} style={plan.signature} />}
                        </View>
                        <View style={s.signLine} />
                        <Text style={s.small}>Authorised Signatory</Text>
                        {(signatory.name || signatory.designation) && (
                            <Text style={{ ...s.small, color: MUTED }}>{[signatory.name, signatory.designation].filter(Boolean).join(', ')}</Text>
                        )}
                    </View>
                )}
            </View>
            {!model.notes && brandLine(ctx)}
        </View>
    );
}

/** The document's notes, which may run to any length and so flow across pages, then the brand's closing line. */
function notes(ctx: Ctx) {
    const {
        ui: { Text, View },
        model,
    } = ctx;
    if (!model.notes) return null;
    return (
        <>
            {/* Keeps the heading with the first lines of the notes. */}
            <View minPresenceAhead={30} />
            <View style={{ marginTop: 10 }}>
                {label(ctx, 'Notes')}
                <Text style={s.small} hyphenationCallback={wrapIn(ctx, CONTENT_WIDTH, TYPE.small)}>
                    {model.notes}
                </Text>
                {brandLine(ctx)}
            </View>
        </>
    );
}

/** Every size other than the body's sets its own line height: an inherited `lineHeight` arrives as the page's 11.5 pt, not as a ratio. */
const LH = TYPE.lineHeight;

const s = {
    page: { paddingTop: PAGE.top, paddingHorizontal: PAGE.side, fontFamily: PDF_FONT_FAMILY, fontSize: TYPE.body, lineHeight: LH, color: INK },
    bold: { fontWeight: 700 },
    muted: { color: MUTED },
    small: { fontSize: TYPE.small, lineHeight: LH },
    detail: { fontSize: TYPE.detail, lineHeight: LH, color: MUTED },
    label: { fontSize: TYPE.label, lineHeight: LH, fontWeight: 700, color: MUTED, letterSpacing: TYPE.labelSpacing, marginBottom: 2 },

    // A large, light, diagonal word across the middle of every page; narrower than the page before it turns, or it overflows to one side.
    watermark: {
        position: 'absolute',
        top: PAGE.height / 2 - 40,
        left: 0,
        right: 0,
        textAlign: 'center',
        fontSize: 80,
        lineHeight: 1,
        fontWeight: 700,
        letterSpacing: 4,
        color: WATERMARK,
        opacity: 0.12,
        transform: 'rotate(-35deg)',
    },
    bar: { position: 'absolute', top: 0, left: 0, right: 0, height: 4 },
    copyMark: {
        position: 'absolute',
        top: 14,
        right: PAGE.side,
        fontSize: 6.4,
        lineHeight: LH,
        fontWeight: 700,
        letterSpacing: 0.8,
        borderWidth: 0.75,
        borderColor: INK,
        paddingVertical: 1.5,
        paddingHorizontal: 5,
    },
    strip: { position: 'absolute', top: 16, left: PAGE.side, width: CONTENT_WIDTH - 150, fontSize: 7, lineHeight: LH, color: MUTED, maxLines: 1, textOverflow: 'ellipsis' },
    footer: {
        position: 'absolute',
        left: PAGE.side,
        right: PAGE.side,
        bottom: FOOTER_BOTTOM,
        paddingTop: 4,
        paddingRight: PAGE_NUMBER_WIDTH,
        borderTopWidth: 0.5,
        borderTopColor: GRID,
        fontSize: TYPE.footer,
        lineHeight: LH,
        color: MUTED,
    },
    // Placed from the top: a dynamic Text placed with `bottom` lands off the page in react-pdf 4.9.
    pageNumber: {
        position: 'absolute',
        top: PAGE.height - FOOTER_BOTTOM - TYPE.footer * TYPE.lineHeight,
        right: PAGE.side,
        width: PAGE_NUMBER_WIDTH,
        textAlign: 'right',
        fontSize: TYPE.footer,
        lineHeight: LH,
        color: MUTED,
    },

    header: { flexDirection: 'row', justifyContent: 'space-between' },
    sellerBlock: { flex: 1, paddingRight: 16 },
    brand: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
    wordmark: { fontSize: 17, fontWeight: 700, lineHeight: 1.2, flexShrink: 1 },
    legalName: { fontSize: 9.5, lineHeight: LH, fontWeight: 700 },
    statusBlock: { width: 210, alignItems: 'flex-end' },
    title: { fontSize: 16, fontWeight: 700, letterSpacing: 1, lineHeight: 1.2, textAlign: 'right' },
    subtitle: { fontSize: 7.2, lineHeight: LH, fontWeight: 700, marginTop: 2, textAlign: 'right' },
    chip: { fontSize: 7, lineHeight: LH, fontWeight: 700, letterSpacing: 0.4, paddingVertical: 2, paddingHorizontal: 6, marginTop: 6, borderRadius: 2 },
    statusLine: { fontSize: 7, lineHeight: LH, color: MUTED, marginTop: 1, textAlign: 'right' },
    statusAmount: { fontSize: 14, fontWeight: 700, lineHeight: 1.25, textAlign: 'right' },

    details: { flexDirection: 'row', marginTop: 10, paddingTop: 7, paddingBottom: 5.5, borderTopWidth: 0.75, borderBottomWidth: 0.75 },
    detailRow: { flexDirection: 'row', marginBottom: 1.5 },
    detailValue: { flex: 1, fontWeight: 700 },
    reference: { marginTop: 9, paddingVertical: 5, paddingHorizontal: 8, backgroundColor: '#F9FAFB', borderLeftWidth: 2 },

    parties: { flexDirection: 'row', marginTop: 9 },
    partyBox: { borderWidth: 0.5, borderColor: GRID, padding: 6 },
    partyName: { fontSize: 9, lineHeight: LH, fontWeight: 700 },

    table: { marginTop: 10 },
    th: { fontSize: TYPE.tableHead, lineHeight: LH, fontWeight: 700, letterSpacing: TYPE.tableHeadSpacing },

    wordsAndTotals: { flexDirection: 'row', marginTop: 10 },
    words: { flex: 1, paddingRight: 16 },
    ladder: { width: '40%' },
    // Inset like the grand total's band, so every figure in the ladder ends on one line.
    ladderRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.2, paddingHorizontal: 6 },
    ladderLabel: { flex: 1, paddingRight: 8 },
    grand: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, paddingHorizontal: 6, marginTop: 4, marginBottom: 2 },
    grandLabel: { fontSize: 10, lineHeight: LH, fontWeight: 700, flex: 1, paddingRight: 8 },
    grandAmount: { fontSize: 12, fontWeight: 700, lineHeight: 1.2 },

    summary: { marginTop: 10, fontSize: 7.2, lineHeight: LH },

    box: { marginTop: 10, borderWidth: 0.5, borderColor: GRID, paddingVertical: 6, paddingHorizontal: 8 },
    qr: { width: 64, height: 64 },
    scanToPay: { fontSize: 9.5, lineHeight: LH, fontWeight: 700 },

    closing: { flexDirection: 'row', marginTop: 10, paddingTop: 8, borderTopWidth: 0.75 },
    // Its own height, not the row's: stretched beside very long terms it could not stay whole.
    signatory: { width: SIGNATORY_WIDTH, alignItems: 'flex-end', alignSelf: 'flex-start' },
    forName: { fontSize: 7.6, lineHeight: LH, fontWeight: 700, textAlign: 'right' },
    signLine: { width: 130, borderTopWidth: 0.5, borderTopColor: INK, marginBottom: 2 },
    footerNote: { marginTop: 14, textAlign: 'center', fontWeight: 700 },
} satisfies Record<string, Style>;
