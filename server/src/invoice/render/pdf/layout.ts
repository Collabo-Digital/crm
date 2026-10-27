import type { DocField, DocImage, DocLine, DocumentModel } from '../document-model';
import { formatAmount } from '../money';

/**
 * Sizes worked out before drawing, from the text itself: react-pdf lays out
 * flexbox but cannot size a column to its widest figure, so the widths come
 * from the font's own advance widths.
 */

/** Width of `text` in points, set in Noto Sans at `size`. */
export type Measure = (text: string, size: number, bold?: boolean, letterSpacing?: number) => number;

/** A4 portrait, 12 mm sides: report 4.1 "Page and type". */
export const PAGE = { width: 595.28, height: 841.89, top: 40, side: 34, bottom: 58 } as const;
export const CONTENT_WIDTH = PAGE.width - 2 * PAGE.side;

export const TYPE = {
    body: 8.5,
    lineHeight: 1.35,
    label: 6.6,
    labelSpacing: 0.6,
    tableHead: 6.6,
    tableHeadSpacing: 0.4,
    detail: 6.8,
    /** Terms, returns, the declaration and notes. */
    small: 7.4,
    footer: 6.4,
} as const;

/** Horizontal padding inside every table cell. */
export const CELL_PAD = 3;

/** The footer sits this far above the paper's edge, clear of a printer's unprintable margin. */
export const FOOTER_BOTTOM = 18;
/** Room kept at the footer's right for "Page 12 of 12". */
export const PAGE_NUMBER_WIDTH = 80;
/** The signatory block's column, right of the terms. */
export const SIGNATORY_WIDTH = 170;

export type ColumnKey = 'index' | 'item' | 'hsn' | 'quantity' | 'rate' | 'discount' | 'taxable' | 'cgst' | 'sgst' | 'igst' | 'amount';
export type TaxColumnKey = 'cgst' | 'sgst' | 'igst';

export interface Column {
    key: ColumnKey;
    label: string;
    /** Points. */
    width: number;
    align: 'left' | 'right';
}

/** "@2.5%": a rate in percent, without trailing zeros. */
export function rateText(rate: number): string {
    return `@${Number(rate.toFixed(3))}%`;
}

/** "−142.86", or an en dash for no discount. */
export function discountText(discount: number): string {
    return discount ? formatAmount(-discount) : '–';
}

/** "1,200" or "12.5": a quantity total, grouped the Indian way. */
export function quantityText(quantity: number): string {
    return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(quantity);
}

/** The tax heads a document's table and totals carry, in print order. */
export function taxColumns(model: Pick<DocumentModel, 'taxHeads'>): TaxColumnKey[] {
    if (model.taxHeads === 'IGST') return ['igst'];
    return model.taxHeads ? ['cgst', 'sgst'] : [];
}

/** "CGST", "SGST", "UTGST" or "IGST". */
export function taxLabel(model: Pick<DocumentModel, 'taxHeads'>, key: TaxColumnKey): string {
    if (key === 'sgst' && model.taxHeads === 'CGST_UTGST') return 'UTGST';
    return key.toUpperCase();
}

/**
 * The Total row's amount: the sum of the amount column. The model carries the
 * other column totals but not this one, so it is added up here, to the paisa.
 */
export function linesAmount(lines: DocLine[]): number {
    return Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
}

/** Share of the content width each column starts from (report 4.1, item 5); the item column takes the rest. */
const BASE: Record<Exclude<ColumnKey, 'item'>, number> = {
    index: 0.04,
    hsn: 0.075,
    quantity: 0.075,
    rate: 0.095,
    discount: 0.08,
    taxable: 0.105,
    cgst: 0.09,
    sgst: 0.09,
    igst: 0.09,
    amount: 0.11,
};

/** Below this the item column wraps names into slivers, so figures give up their spare room first. */
const ITEM_MIN = 120;

/**
 * The item table's columns, only those the model asks for, each at least as
 * wide as its widest figure (Total row included) so no amount ever wraps.
 */
export function tableColumns(model: DocumentModel, measure: Measure): Column[] {
    const { lines, totals } = model;
    const taxes = taxColumns(model);
    const body = (text: string, bold = false) => measure(text, TYPE.body, bold);
    const head = (label: string) => Math.max(...label.toUpperCase().split(' ').map((word) => measure(word, TYPE.tableHead, true, TYPE.tableHeadSpacing)));

    const columns: Array<{ key: ColumnKey; label: string; align: 'left' | 'right'; need: number }> = [];
    const add = (key: ColumnKey, label: string, align: 'left' | 'right', widths: number[]) =>
        columns.push({ key, label, align, need: Math.max(head(label), ...widths) + 2 * CELL_PAD });

    add('index', '#', 'left', [body('00'), ...lines.map((line) => body(String(line.index)))]);
    add('item', 'Item & description', 'left', []);
    if (model.showHsn) add('hsn', 'HSN', 'left', lines.map((line) => body(line.hsn ?? '')));
    add('quantity', 'Qty', 'right', [...lines.map((line) => body(line.quantity)), totals.quantity === null ? 0 : body(quantityText(totals.quantity), true)]);
    add('rate', model.taxHeads ? 'Rate' : 'Price', 'right', lines.map((line) => body(formatAmount(line.rate))));
    if (model.showDiscount) add('discount', 'Disc.', 'right', [...lines.map((line) => body(discountText(line.discount))), body(discountText(totals.discount), true)]);
    if (model.taxHeads) add('taxable', 'Taxable value', 'right', [...lines.map((line) => body(formatAmount(line.taxable))), body(formatAmount(totals.taxable), true)]);
    for (const key of taxes) {
        const cells = lines.map((line) => line[key]).filter((cell) => cell !== null);
        add(key, taxLabel(model, key), 'right', [
            ...cells.map((cell) => Math.max(body(formatAmount(cell.amount)), measure(rateText(cell.rate), TYPE.detail))),
            body(formatAmount(totals[key]), true),
        ]);
    }
    add('amount', 'Amount', 'right', [...lines.map((line) => body(formatAmount(line.amount), true)), body(formatAmount(linesAmount(lines)), true)]);

    const fixed = columns.filter((column) => column.key !== 'item');
    let widths = fixed.map((column) => Math.max(column.need, BASE[column.key as keyof typeof BASE] * CONTENT_WIDTH));
    // Big figures widen their columns; when that squeezes the item column, each figure column gives back its spare room, in proportion.
    const deficit = ITEM_MIN - (CONTENT_WIDTH - sum(widths));
    const spare = sum(widths.map((width, i) => width - fixed[i].need));
    if (deficit > 0 && spare > 0) {
        const share = Math.min(1, deficit / spare);
        widths = widths.map((width, i) => width - (width - fixed[i].need) * share);
    }
    const item = CONTENT_WIDTH - sum(widths);
    return columns.map(({ key, label, align }) => ({ key, label, align, width: key === 'item' ? item : widths[fixed.findIndex((column) => column.key === key)] }));
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Gap after each column of the details block. */
export const DETAIL_GAP = 10;

/**
 * The details block: label and value pairs in two columns (up to four
 * fields) or three, filled top to bottom so they read in the model's order,
 * as evenly as they go (seven fields are 3, 2 and 2, not 3, 3 and 1). Each
 * column's labels are as wide as its longest one.
 */
export function detailColumns(details: DocField[], measure: Measure): Array<{ fields: DocField[]; labelWidth: number }> {
    if (!details.length) return [];
    const count = details.length <= 4 ? 2 : 3;
    const columnWidth = CONTENT_WIDTH / count - DETAIL_GAP;
    const columns: Array<{ fields: DocField[]; labelWidth: number }> = [];
    let start = 0;
    for (let i = 0; i < count && start < details.length; i++) {
        const size = Math.floor(details.length / count) + (i < details.length % count ? 1 : 0);
        const fields = details.slice(start, start + size);
        start += size;
        const longest = Math.max(...fields.map((field) => measure(field.label, TYPE.body)));
        columns.push({ fields, labelWidth: Math.min(longest + 8, columnWidth * 0.45) });
    }
    return columns;
}

/**
 * A measure for text that wraps, narrowed so its lines come out even rather
 * than one long line and a lone last word.
 */
export function balancedWidth(textWidth: number, maxWidth: number): number {
    const lines = Math.ceil(textWidth / maxWidth);
    return lines <= 1 ? maxWidth : Math.min(maxWidth, textWidth / lines + 16);
}

/**
 * The every-page footer's lines, and the page's bottom margin: enough for
 * them however they wrap (a long registered office runs to two lines), and
 * never less than the design's 58 pt.
 */
export function footerPlan(model: DocumentModel, measure: Measure): { lines: string[]; pageBottom: number } {
    const lines = [...model.footer.lines, model.footer.computerGenerated].filter((line): line is string => !!line);
    const width = CONTENT_WIDTH - PAGE_NUMBER_WIDTH;
    const rows = sum(lines.map((line) => Math.max(1, Math.ceil(measure(line, TYPE.footer) / width))));
    const height = rows * TYPE.footer * TYPE.lineHeight + 4;
    return { lines, pageBottom: Math.max(PAGE.bottom, Math.ceil(FOOTER_BOTTOM + height + 10)) };
}

/** Height of one line of text at `size`. */
const lineOf = (size: number) => size * TYPE.lineHeight;

/**
 * Lines a paragraph takes in a box `width` points wide: a line per hard break,
 * and what its words measure with a tenth to spare, since lines wrap at word
 * ends and never come out fuller than that.
 */
export function lineCount(text: string, width: number, measure: Measure, size: number, bold = false): number {
    return text.split('\n').reduce((lines, part) => lines + Math.max(1, Math.ceil((measure(part, size, bold) * 1.1) / width)), 0);
}

/** Room for flowing content on each page, between the top margin and the footer. */
export function contentHeight(pageBottom: number): number {
    return PAGE.height - PAGE.top - pageBottom;
}

/**
 * How tall the terms-and-signatory block comes out, so it is kept on one page
 * only when one page can hold it: react-pdf squeezes the whole page, and drops
 * the footer, when a block that may not split is taller than the page.
 */
export function closingHeight(model: DocumentModel, measure: Measure): number {
    const label = lineOf(TYPE.label) + 2;
    const small = lineOf(TYPE.small);
    const left = CONTENT_WIDTH - (model.signatory ? SIGNATORY_WIDTH : 0) - 14;
    const parts = [
        model.terms.length ? label + sum(model.terms.map((term) => lineCount(term, left - 12, measure, TYPE.small) * small)) : 0,
        model.returns ? label + lineCount(model.returns, left, measure, TYPE.small) * small : 0,
        model.declaration ? label + lineCount(model.declaration, left, measure, TYPE.small) * small : 0,
    ].filter((height) => height > 0);
    const terms = sum(parts) + 6 * Math.max(0, parts.length - 1);
    const signatory = model.signatory ? lineCount(model.signatory.forName, SIGNATORY_WIDTH, measure, 7.6, true) * lineOf(7.6) + 42 + 3 + 2 * small : 0;
    // The brand's closing line travels with this block when there are no notes to carry it.
    const brandLine = model.footer.note && !model.notes ? 14 + lineOf(TYPE.body) : 0;
    return 18 + Math.max(terms, signatory) + brandLine;
}

/** How tall the box of payments received comes out. */
export function paymentHeight(model: DocumentModel, measure: Measure): number {
    if (model.payment?.kind !== 'received') return 0;
    return 23 + lineOf(TYPE.label) + sum(model.payment.lines.map((line) => lineCount(line, CONTENT_WIDTH - 17, measure, TYPE.body) * lineOf(TYPE.body)));
}

/**
 * The table's top margin, header and first row: how much room the table needs
 * at the foot of a page before it may start there, so its header is never left
 * alone with every row on the next page.
 */
export function tableLead(model: DocumentModel, columns: Column[], measure: Measure): number {
    const header = Math.max(...columns.map((column) => lineCount(column.label.toUpperCase(), column.width - 2 * CELL_PAD, measure, TYPE.tableHead, true))) * lineOf(TYPE.tableHead);
    const first = model.lines[0];
    const item = columns.find((column) => column.key === 'item')!.width - 2 * CELL_PAD;
    const row = first
        ? Math.max(
              lineCount(first.name, item, measure, TYPE.body, true) * lineOf(TYPE.body) + (first.detail ? lineCount(first.detail, item, measure, TYPE.detail) * lineOf(TYPE.detail) : 0),
              lineOf(TYPE.body) + lineOf(TYPE.detail),
          )
        : 0;
    return 10 + header + 7 + row + 7;
}

/**
 * Break points for a word: after each separator, and every 8 characters of
 * what is left, but never beside a hyphen, since react-pdf adds one where it
 * breaks. Plain ASCII only; letters in other scripts may join.
 */
export function wordParts(word: string): string[] {
    if (!/^[\x21-\x7e]+$/.test(word)) return [word];
    const parts = word.split(/(?<=[/.?&=_@:,])/).flatMap((part) => part.match(/.{1,8}/g) ?? [part]);
    return parts.reduce<string[]>((kept, part) => {
        const last = kept.length - 1;
        if (last >= 0 && (kept[last].endsWith('-') || part.startsWith('-'))) kept[last] += part;
        else kept.push(part);
        return kept;
    }, []);
}

/**
 * A react-pdf hyphenation callback for a box `width` points wide. react-pdf
 * breaks lines only at spaces, so a word wider than its box (a pasted link, a
 * long SKU) runs out of it and over the next column; such a word gets break
 * points, and react-pdf adds a hyphen where it breaks. Every other word stays
 * whole: given break points, react-pdf would rather hyphenate a name than
 * leave a line short.
 */
export function breakWordsWiderThan(width: number, measure: Measure, size: number, bold = false): (word: string) => string[] {
    return (word) => (measure(word, size, bold) > width ? wordParts(word) : [word]);
}

/** Pixel size from the file's header: PNG's IHDR chunk, or a JPEG's start-of-frame marker. Null when it does not read. */
export function imagePixels(image: DocImage): { width: number; height: number } | null {
    const data = image.data;
    if (image.format === 'png') {
        if (data.length < 24 || data.toString('latin1', 12, 16) !== 'IHDR') return null;
        return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    let at = 2;
    let orientation = 1;
    while (at + 9 < data.length && data[at] === 0xff) {
        const marker = data[at + 1];
        const length = data.readUInt16BE(at + 2);
        if (marker === 0xe1) orientation = exifOrientation(data, at + 4, at + 2 + length);
        // SOF0 to SOF15 carry the size; C4, C8 and CC share the range but are tables.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const width = data.readUInt16BE(at + 7);
            const height = data.readUInt16BE(at + 5);
            // A phone photo stored on its side: react-pdf turns it upright, so it is as wide as it is tall here.
            return orientation > 4 ? { width: height, height: width } : { width, height };
        }
        at += 2 + length;
    }
    return null;
}

/** The orientation tag (1 to 8) from a JPEG's APP1 segment, between `start` and `end`; 1 when there is none. */
function exifOrientation(data: Buffer, start: number, end: number): number {
    if (end > data.length || data.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1;
    const tiff = start + 6;
    const little = data.toString('latin1', tiff, tiff + 2) === 'II';
    const u16 = (at: number) => (little ? data.readUInt16LE(at) : data.readUInt16BE(at));
    const ifd = tiff + (little ? data.readUInt32LE(tiff + 4) : data.readUInt32BE(tiff + 4));
    if (ifd + 2 > end) return 1;
    for (let i = 0, count = u16(ifd); i < count && ifd + 14 + i * 12 <= end; i++) {
        const entry = ifd + 2 + i * 12;
        if (u16(entry) === 0x0112) return u16(entry + 8);
    }
    return 1;
}

/** The image scaled to fit the box, keeping its proportions; null when its size cannot be read. */
export function fitImage(image: DocImage, maxWidth: number, maxHeight: number): { width: number; height: number } | null {
    const pixels = imagePixels(image);
    if (!pixels || !pixels.width || !pixels.height) return null;
    const scale = Math.min(maxWidth / pixels.width, maxHeight / pixels.height);
    return { width: pixels.width * scale, height: pixels.height * scale };
}
