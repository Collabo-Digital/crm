import type * as ReactPdf from '@react-pdf/renderer';
import * as QRCode from 'qrcode';
import { PDF_FONT_FAMILY, registerPdfFonts } from '../../pdf/fonts';
import type { DocumentModel } from './document-model';
import { DocumentPdf, type DocumentPlan } from './pdf/document';
import {
    balancedWidth,
    closingHeight,
    contentHeight,
    detailColumns,
    fitImage,
    footerPlan,
    type Measure,
    paymentHeight,
    tableColumns,
    tableLead,
} from './pdf/layout';
import { paletteOf } from './pdf/theme';

/** The PDF engine is an ES module; the server is CommonJS, so it is loaded on first use. */
let engine: Promise<typeof ReactPdf> | null = null;
const loadEngine = () => (engine ??= import('@react-pdf/renderer'));

/** The part of a loaded fontkit font that measuring needs; fontkit ships no types. */
interface LoadedFont {
    unitsPerEm: number;
    layout(text: string): { advanceWidth: number };
}

/**
 * Text widths in Noto Sans, from the same font files react-pdf draws with, so
 * columns sized here fit what is drawn. Digits are tabular, so a figure's
 * width is exact.
 */
async function measurer(Font: typeof ReactPdf.Font): Promise<Measure> {
    const [regular, bold] = await Promise.all(
        [400, 700].map(async (fontWeight) => {
            const descriptor = { fontFamily: PDF_FONT_FAMILY[0], fontWeight };
            await Font.load(descriptor);
            return Font.getFont(descriptor).data as unknown as LoadedFont;
        }),
    );
    return (text, size, isBold = false, letterSpacing = 0) => {
        const font = isBold ? bold : regular;
        return (font.layout(text).advanceWidth / font.unitsPerEm) * size + letterSpacing * text.length;
    };
}

/** Draws a document as an A4 PDF: exactly what the model says, laid out as report 4.1 describes. */
export async function renderDocumentPdf(model: DocumentModel): Promise<Buffer> {
    const rp = await loadEngine();
    registerPdfFonts(rp.Font);
    const measure = await measurer(rp.Font);
    const upiUri = model.payment?.kind === 'due' ? model.payment.upiUri : null;
    const columns = tableColumns(model, measure);
    const footer = footerPlan(model, measure);
    const room = contentHeight(footer.pageBottom);
    const plan: DocumentPlan = {
        columns,
        details: detailColumns(model.details, measure),
        footer,
        logo: model.seller.logo && fitImage(model.seller.logo, 140, 40),
        signature: model.signatory?.image ? fitImage(model.signatory.image, 96, 30) : null,
        qr: upiUri ? await QRCode.toDataURL(upiUri, { errorCorrectionLevel: 'M', margin: 1, scale: 6 }) : null,
        subtitleWidth: balancedWidth(model.subtitle ? measure(model.subtitle, 7.2, true) : 0, 210),
        palette: paletteOf(model.theme, model.brandColor),
        measure,
        tableLead: tableLead(model, columns, measure),
        keepTogether: { closing: closingHeight(model, measure) < room, payment: paymentHeight(model, measure) < room },
    };
    return rp.renderToBuffer(<DocumentPdf rp={rp} model={model} plan={plan} />);
}
