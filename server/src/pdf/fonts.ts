import { join } from 'node:path';
import type * as ReactPdf from '@react-pdf/renderer';

/**
 * The fonts every PDF is set in. The built-in Helvetica has no rupee sign and
 * no Indian script: it printed "₹" as "¹" and Hindi as noise. Noto Sans has ₹
 * and tabular digits; Noto Sans Devanagari is the fallback react-pdf picks
 * character by character, so a Hindi product or customer name prints.
 *
 * SIL Open Font License 1.1, whose text sits beside the files. nest-cli.json
 * copies the folder to dist/src/pdf/fonts, beside the compiled file; Jest
 * reads it from src.
 */
const dir = join(__dirname, 'fonts');

/** The `fontFamily` for every style: Latin and ₹ first, then Devanagari. */
export const PDF_FONT_FAMILY = ['NotoSans', 'NotoSansDevanagari'];

let registered = false;

/** Registers the fonts on react-pdf's `Font`, once per process. */
export function registerPdfFonts(Font: typeof ReactPdf.Font): void {
    if (registered) return;
    Font.register({
        family: 'NotoSans',
        fonts: [
            { src: join(dir, 'NotoSans-Regular.ttf'), fontWeight: 400 },
            { src: join(dir, 'NotoSans-Bold.ttf'), fontWeight: 700 },
        ],
    });
    Font.register({
        family: 'NotoSansDevanagari',
        fonts: [
            { src: join(dir, 'NotoSansDevanagari-Regular.ttf'), fontWeight: 400 },
            { src: join(dir, 'NotoSansDevanagari-Bold.ttf'), fontWeight: 700 },
        ],
    });
    // react-pdf hyphenates by default, which splits names, SKUs and amounts.
    Font.registerHyphenationCallback((word) => [word]);
    registered = true;
}
