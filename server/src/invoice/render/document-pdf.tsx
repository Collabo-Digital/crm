import type { DocumentModel } from './document-model';

/** Draws a document as an A4 PDF. */
export async function renderDocumentPdf(model: DocumentModel): Promise<Buffer> {
    throw new Error(`The document renderer is not built yet (${model.documentNumber}).`);
}
