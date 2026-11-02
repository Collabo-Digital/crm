import { readFileSync } from 'fs';
import { join } from 'path';
import type { DocImage, DocumentModel } from '../document-model';
import { formatAmount } from '../money';
import { DOCUMENT_FIXTURES } from './fixtures/documents';
import {
    balancedWidth,
    breakWordsWiderThan,
    CELL_PAD,
    type ColumnKey,
    CONTENT_WIDTH,
    detailColumns,
    discountText,
    fitImage,
    FOOTER_BOTTOM,
    footerPlan,
    imagePixels,
    linesAmount,
    type Measure,
    PAGE,
    PAGE_NUMBER_WIDTH,
    quantityText,
    rateText,
    tableColumns,
    TYPE,
    wordParts,
} from './layout';

/** A stand-in for Noto Sans: its figure widths (digits and minus 0.572 em, comma and point 0.268 em), other characters about 0.55 em. */
const measure: Measure = (text, size, bold = false, spacing = 0) =>
    [...text].reduce((width, c) => width + size * (/[\d−]/.test(c) ? 0.572 : /[,.]/.test(c) ? 0.268 : c === ' ' ? 0.26 : bold ? 0.6 : 0.55) + spacing, 0);

const keys = (name: keyof typeof DOCUMENT_FIXTURES) => tableColumns(DOCUMENT_FIXTURES[name](), measure).map((column) => column.key);

describe('tableColumns', () => {
    it('carries only the columns the model asks for', () => {
        expect(keys('b2c-intra-paid-modern-hindi')).toEqual(['index', 'item', 'hsn', 'quantity', 'rate', 'discount', 'taxable', 'cgst', 'sgst', 'amount']);
        expect(keys('b2c-inter-discount-light-brand')).toEqual(['index', 'item', 'hsn', 'quantity', 'rate', 'discount', 'taxable', 'igst', 'amount']);
        expect(keys('union-territory-utgst-cod')).toEqual(['index', 'item', 'hsn', 'quantity', 'rate', 'taxable', 'cgst', 'sgst', 'amount']);
        expect(keys('bill-of-supply-composition')).toEqual(['index', 'item', 'hsn', 'quantity', 'rate', 'discount', 'amount']);
        expect(keys('bill-no-gst')).toEqual(['index', 'item', 'quantity', 'rate', 'amount']);
    });

    it('labels UTGST where SGST would be, and the price as a price when there is no tax', () => {
        const labels = (name: keyof typeof DOCUMENT_FIXTURES) => tableColumns(DOCUMENT_FIXTURES[name](), measure).map((column) => column.label);
        expect(labels('union-territory-utgst-cod')).toContain('UTGST');
        expect(labels('union-territory-utgst-cod')).not.toContain('SGST');
        expect(labels('bill-of-supply-composition')).toContain('Price');
        expect(labels('b2c-intra-paid-modern-hindi')).toContain('Rate');
    });

    /** Every figure a column prints, as drawn: [text, size, bold]. */
    const figures = (m: DocumentModel, key: ColumnKey): Array<[string, number, boolean]> => {
        const body = (text: string, bold = false): [string, number, boolean] => [text, TYPE.body, bold];
        switch (key) {
            case 'quantity':
                return [...m.lines.map((line) => body(line.quantity)), ...(m.totals.quantity === null ? [] : [body(quantityText(m.totals.quantity), true)])];
            case 'rate':
                return m.lines.map((line) => body(formatAmount(line.rate)));
            case 'discount':
                return [...m.lines.map((line) => body(discountText(line.discount))), body(discountText(m.totals.discount), true)];
            case 'taxable':
                return [...m.lines.map((line) => body(formatAmount(line.taxable))), body(formatAmount(m.totals.taxable), true)];
            case 'cgst':
            case 'sgst':
            case 'igst':
                return [
                    ...m.lines.flatMap((line) => (line[key] ? [body(formatAmount(line[key].amount)), [rateText(line[key].rate), TYPE.detail, false] as [string, number, boolean]] : [])),
                    body(formatAmount(m.totals[key]), true),
                ];
            case 'amount':
                return [...m.lines.map((line) => body(formatAmount(line.amount), true)), body(formatAmount(linesAmount(m.lines)), true)];
            default:
                return [];
        }
    };

    it('fills the content width exactly, every column wide enough for its widest figure', () => {
        for (const [name, build] of Object.entries(DOCUMENT_FIXTURES)) {
            const m = build();
            const columns = tableColumns(m, measure);
            expect([name, columns.reduce((sum, column) => sum + column.width, 0)]).toEqual([name, expect.closeTo(CONTENT_WIDTH, 6)]);
            for (const column of columns) {
                for (const [text, size, bold] of figures(m, column.key)) expect([name, text, measure(text, size, bold) + 2 * CELL_PAD <= column.width + 1e-9]).toEqual([name, text, true]);
            }
        }
    });

    it('keeps the design’s proportions for ordinary figures, and gives up spare room before squeezing the item column', () => {
        const ordinary = tableColumns(DOCUMENT_FIXTURES['b2c-intra-paid-modern-hindi'](), measure);
        expect(ordinary.find((column) => column.key === 'amount')!.width).toBeCloseTo(0.11 * CONTENT_WIDTH, 6);
        const crores = tableColumns(DOCUMENT_FIXTURES['long-names'](), measure);
        expect(crores.find((column) => column.key === 'item')!.width).toBeCloseTo(120, 6);
        expect(crores.find((column) => column.key === 'index')!.width).toBeGreaterThanOrEqual(measure('00', 8.5) + 6);
    });
});

describe('detailColumns', () => {
    const fields = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Label ${i + 1}`, value: `Value ${i + 1}` }));
    const sizes = (n: number) => detailColumns(fields(n), measure).map((column) => column.fields.length);

    it('two columns up to four fields, three after, filled evenly top to bottom', () => {
        expect(sizes(0)).toEqual([]);
        expect(sizes(2)).toEqual([1, 1]);
        expect(sizes(4)).toEqual([2, 2]);
        expect(sizes(5)).toEqual([2, 2, 1]);
        expect(sizes(7)).toEqual([3, 2, 2]);
        expect(sizes(10)).toEqual([4, 3, 3]);
        expect(detailColumns(fields(7), measure).flatMap((column) => column.fields)).toEqual(fields(7));
    });

    it('sizes each column’s labels to its longest', () => {
        const [first] = detailColumns([{ label: 'Place of supply', value: 'Kerala (32)' }, { label: 'AWB', value: '1' }], measure);
        expect(first.labelWidth).toBeCloseTo(measure('Place of supply', 8.5) + 8, 6);
    });
});

describe('footerPlan', () => {
    const base = DOCUMENT_FIXTURES['b2c-intra-paid-modern-hindi']();

    it('keeps the design’s 58 pt bottom margin for a short footer', () => {
        expect(footerPlan(base, measure)).toEqual({ lines: [...base.footer.lines, base.footer.computerGenerated], pageBottom: PAGE.bottom });
        expect(footerPlan({ ...base, footer: { lines: [], computerGenerated: null, note: null } }, measure).lines).toEqual([]);
    });

    it('grows the margin when the footer wraps, by every line it wraps to, so it never runs into the page', () => {
        const office = 'Registered office: ' + 'Very long street name, '.repeat(12);
        const long = { ...base, footer: { ...base.footer, lines: [office, ...base.footer.lines] } };
        const rows = Math.ceil(measure(office, TYPE.footer) / (CONTENT_WIDTH - PAGE_NUMBER_WIDTH)) + 2 + 1;
        expect(rows).toBeGreaterThan(4);
        expect(footerPlan(long, measure).pageBottom).toBeGreaterThanOrEqual(FOOTER_BOTTOM + rows * TYPE.footer * TYPE.lineHeight + 4);
    });
});

describe('images', () => {
    const fixture = (file: string, format: DocImage['format']): DocImage => ({ data: readFileSync(join(__dirname, 'fixtures', file)), format });

    it('reads the size from a PNG’s or a JPEG’s header', () => {
        expect(imagePixels(fixture('logo-mark.png', 'png'))).toEqual({ width: 300, height: 300 });
        expect(imagePixels(fixture('logo-wordmark.jpg', 'jpg'))).toEqual({ width: 840, height: 200 });
        expect(imagePixels(fixture('signature.png', 'png'))).toEqual({ width: 480, height: 150 });
    });

    it('reads a JPEG stored on its side (EXIF orientation 6) as react-pdf draws it, upright', () => {
        const photo = fixture('signature-photo.jpg', 'jpg');
        expect(imagePixels(photo)).toEqual({ width: 480, height: 150 });
        expect(fitImage(photo, 96, 30)).toEqual({ width: 96, height: 30 });
    });

    it('treats an image whose header does not read as no image', () => {
        expect(imagePixels({ data: Buffer.from('not an image at all, not even close'), format: 'png' })).toBeNull();
        expect(imagePixels({ data: Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]), format: 'jpg' })).toBeNull();
        expect(fitImage({ data: Buffer.alloc(10), format: 'png' }, 140, 40)).toBeNull();
    });

    it('fits an image in its box, keeping its proportions', () => {
        expect(fitImage(fixture('logo-mark.png', 'png'), 140, 40)).toEqual({ width: 40, height: 40 });
        const wide = fitImage(fixture('logo-wordmark.jpg', 'jpg'), 140, 40)!;
        expect(wide.width).toBeCloseTo(140, 6);
        expect(wide.height).toBeCloseTo(33.33, 2);
    });
});

describe('balancedWidth', () => {
    it('leaves a one-line text its full measure, and evens out two lines', () => {
        expect(balancedWidth(150, 210)).toBe(210);
        expect(balancedWidth(0, 210)).toBe(210);
        const width = balancedWidth(260, 210);
        expect(width).toBeLessThan(210);
        expect(width).toBeGreaterThan(130);
    });
});

describe('breaking words too wide for their box', () => {
    it('splits a link or a SKU after its separators and every 8 characters, and nothing outside plain ASCII', () => {
        const link = 'https://docs.google.com/forms/d/e/1FAIpQLSdLongIdentifier/viewform?usp=sf_link';
        const parts = wordParts(link);
        expect(parts.join('')).toBe(link);
        expect(parts).toContain('google.');
        expect(Math.max(...parts.map((part) => part.length))).toBeLessThanOrEqual(8);
        expect(wordParts('SUPERLONGPRODUCTNAMEWITHOUTSPACES')).toEqual(['SUPERLON', 'GPRODUCT', 'NAMEWITH', 'OUTSPACE', 'S']);
        // A break beside a hyphen would print two.
        expect(wordParts('UCODE-1234567890-ABCDEFGHIJ')).toEqual(['UCODE-12', '34567890-ABCDEFG', 'HIJ']);
        expect(wordParts('VH-DHT-ANGAVASTRAM-4M-OFFWHITE')).toEqual(['VH-DHT-A', 'NGAVASTR', 'AM-4M-OF', 'FWHITE']);
        expect(wordParts('बनारसीसिल्कदुपट्टाबनारसीसिल्कदुपट्टा')).toEqual(['बनारसीसिल्कदुपट्टाबनारसीसिल्कदुपट्टा']);
    });

    it('leaves every word that fits its box whole, however long', () => {
        const wrap = breakWordsWiderThan(150, measure, 9, true);
        expect(wrap('Subramaniam-Venkataraghavan')).toEqual(['Subramaniam-Venkataraghavan']);
        expect(wrap('1,16,28,750.00')).toEqual(['1,16,28,750.00']);
        expect(breakWordsWiderThan(60, measure, 9, true)('Subramaniam-Venkataraghavan').length).toBeGreaterThan(1);
    });
});
