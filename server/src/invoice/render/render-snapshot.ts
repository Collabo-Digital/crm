import { z } from 'zod';
import { InvoiceSettingsSchema } from '../../organization-settings/schemas/invoice-settings.schema';

/**
 * What an invoice or credit note looked like when it was issued, kept at
 * `Invoice.metadata.render`. The statutory values already have columns; this
 * is everything else the PDF prints that the merchant can change later: the
 * design settings, the trading name, logo and contacts, the UPI id, and which
 * document the sale was (a Bill of Supply under the composition scheme stays
 * one after the merchant leaves it).
 *
 * Written once, in the issuing transaction; read on every render. Documents
 * issued before this existed have none and render with the current settings.
 */
export const RenderSnapshotSchema = z.object({
    v: z.literal(1),
    /** The tax treatment. A credit note carries its original's. */
    documentType: z.enum(['TAX_INVOICE', 'BILL_OF_SUPPLY']),
    /** Prints the Rule 5(1)(f) line under the title. */
    composition: z.boolean(),
    /** Prints the Rule 46(s) declaration: e-invoicing was on and this document has no IRN. */
    eInvoiceDeclaration: z.boolean(),
    design: InvoiceSettingsSchema,
    brand: z.object({
        /** Store profile name, else the organization's name. */
        tradeName: z.string(),
        /** The uploaded logo then in use; uploaded files are never deleted. */
        logoStorageKey: z.string().nullable(),
        supportPhone: z.string(),
        whatsappPhone: z.string(),
        supportEmail: z.string(),
        website: z.string(),
        /** The till's UPI id (`posSettings.upiId`), for the QR on unpaid documents. */
        upiId: z.string().nullable(),
    }),
});

export type RenderSnapshot = z.infer<typeof RenderSnapshotSchema>;

/** The snapshot in an invoice's `metadata`, or null when it has none or it no longer parses. */
export function readRenderSnapshot(metadata: unknown): RenderSnapshot | null {
    const render = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).render : undefined;
    const parsed = RenderSnapshotSchema.safeParse(render);
    return parsed.success ? parsed.data : null;
}
