import { z } from 'zod';

/**
 * How the organization's invoices, bills and receipts look, and which
 * optional blocks they print. Stored as `OrganizationSettings.invoiceSettings`
 * (JSONB) and validated here before any write.
 *
 * Only the brand's choices live here. What GST requires on a document (title,
 * copy mark, GSTIN, number and date, place of supply, HSN, quantity with unit,
 * taxable value, each tax with its rate, reverse charge) is not a setting and
 * cannot be hidden or renamed.
 *
 * Each issued invoice keeps a copy of these values in
 * `Invoice.metadata.render` (see invoice/render/render-snapshot.ts), so
 * changing them never changes a document already sent.
 *
 * Kept FLAT, like its siblings: the service merges with a shallow spread.
 * `businessIds` is the one list, and a PATCH replaces it whole.
 */

/** IDs a brand can print beside its GSTIN. PAN is not here: it is read off the GSTIN. */
export const BUSINESS_ID_TYPES = ['CIN', 'FSSAI', 'UDYAM', 'IEC', 'LUT', 'DL', 'CUSTOM'] as const;
export type BusinessIdType = (typeof BUSINESS_ID_TYPES)[number];
export const MAX_BUSINESS_IDS = 6;

const BusinessIdSchema = z.object({
  type: z.enum(BUSINESS_ID_TYPES),
  /** Printed only for CUSTOM; the others carry their standard label. */
  label: z.string().trim().max(24).default(''),
  value: z.string().trim().min(1).max(40),
  onA4: z.boolean().default(true),
  onReceipt: z.boolean().default(false),
});
export type BusinessId = z.infer<typeof BusinessIdSchema>;

const ContactShown = z.enum(['hide', 'mask', 'show']);

/** An uploaded image: the stored file, and the public URL the app shows it at. */
const StoredImageSchema = z.object({ storageKey: z.string().min(1), url: z.string().min(1) });

export const InvoiceSettingsSchema = z.object({
  /** Modern: whitespace and brand-colour accents. Classic: a fully ruled grid in ink only. */
  theme: z.enum(['modern', 'classic']).default('modern'),
  /** Invoices to GST-registered buyers use Classic whatever `theme` says: their accountants expect it. */
  classicForB2b: z.boolean().default(true),
  /** `#RRGGBB`. Null prints in ink. */
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),

  /** PAN, read off characters 3 to 12 of the seller's GSTIN. */
  showPan: z.boolean().default(true),
  businessIds: z.array(BusinessIdSchema).max(MAX_BUSINESS_IDS).default([]),
  /** Companies print their registered office (and CIN) on billheads. */
  registeredOffice: z.string().default(''),
  /** The store profile's support phone, WhatsApp and email in the header and footer. */
  showSupportContact: z.boolean().default(true),

  /** One term per line; printed numbered. */
  terms: z.string().default(''),
  returnPolicy: z.string().default(''),
  returnPolicyUrl: z.string().default(''),
  footerNote: z.string().default('Thank you for shopping with us.'),

  /**
   * `computer`: no signatory block, and the footer says the document is
   * computer-generated and needs no signature (Rule 46(q) proviso for
   * electronic invoices). `image`: "For <legal name>", the uploaded signature,
   * "Authorised Signatory". `blank`: the same block with space to sign.
   * Credit notes ignore `computer`: Rule 53 has no electronic exemption.
   */
  signatureMode: z.enum(['computer', 'image', 'blank']).default('computer'),
  /** Set and cleared only by the signature upload, never by PATCH. */
  signature: StoredImageSchema.nullable().default(null),
  signatoryName: z.string().default(''),
  signatoryDesignation: z.string().default(''),

  showSku: z.boolean().default(true),
  amountInWords: z.boolean().default(true),
  /** `auto`: when the document has more than one HSN or rate. B2B invoices always carry it. */
  taxSummary: z.enum(['auto', 'always', 'never']).default('auto'),
  /** The buyer's phone and email on A4 documents. Rule 46 does not ask for them. */
  customerContact: ContactShown.default('hide'),
  /** The buyer's phone on the till's receipt. */
  receiptCustomerContact: ContactShown.default('mask'),
  /** A UPI QR for the balance on unpaid invoices. Never on cash-on-delivery orders. */
  upiQr: z.enum(['unpaid', 'never']).default('unpaid'),
  /** The QR on the till's receipt: the e-bill link, a UPI QR while money is due, or none. */
  receiptQr: z.enum(['ebill', 'upi-when-due', 'off']).default('ebill'),
});

export type InvoiceSettings = z.infer<typeof InvoiceSettingsSchema>;

const optionalUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), {
    message: 'Enter a full URL starting with http:// or https://, or leave it blank.',
  })
  .optional();

/**
 * Patch schema: every field truly optional, WITHOUT defaults, so a PATCH that
 * sets only `theme` cannot reset the merchant's terms during the merge. The
 * signature image is absent on purpose: it is set by its upload route.
 */
export const UpdateInvoiceSettingsSchema = z.object({
  theme: z.enum(['modern', 'classic']).optional(),
  classicForB2b: z.boolean().optional(),
  brandColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, { message: 'Enter a colour like #1F6F5C.' })
    .transform((v) => v.toUpperCase())
    .nullable()
    .optional(),
  showPan: z.boolean().optional(),
  businessIds: z
    .array(BusinessIdSchema)
    .max(MAX_BUSINESS_IDS, { message: `Up to ${MAX_BUSINESS_IDS} business IDs.` })
    .refine((ids) => ids.every((id) => id.type !== 'CUSTOM' || id.label.length > 0), {
      message: 'Give each custom ID a label.',
    })
    .optional(),
  registeredOffice: z.string().trim().max(200).optional(),
  showSupportContact: z.boolean().optional(),
  terms: z.string().trim().max(1000).optional(),
  returnPolicy: z.string().trim().max(300).optional(),
  returnPolicyUrl: optionalUrl,
  footerNote: z.string().trim().max(150).optional(),
  signatureMode: z.enum(['computer', 'image', 'blank']).optional(),
  signatoryName: z.string().trim().max(60).optional(),
  signatoryDesignation: z.string().trim().max(60).optional(),
  showSku: z.boolean().optional(),
  amountInWords: z.boolean().optional(),
  taxSummary: z.enum(['auto', 'always', 'never']).optional(),
  customerContact: ContactShown.optional(),
  receiptCustomerContact: ContactShown.optional(),
  upiQr: z.enum(['unpaid', 'never']).optional(),
  receiptQr: z.enum(['ebill', 'upi-when-due', 'off']).optional(),
});
export type UpdateInvoiceSettingsInput = z.infer<typeof UpdateInvoiceSettingsSchema>;

/**
 * Apply schema defaults to an unknown value, or fall through to defaults.
 * `safeParse`, like its siblings: every PDF reads this, and a corrupt blob
 * must degrade to the default look rather than stop documents rendering.
 */
export function parseInvoiceSettings(value: unknown): InvoiceSettings {
  const result = InvoiceSettingsSchema.safeParse(value ?? {});
  return result.success ? result.data : InvoiceSettingsSchema.parse({});
}
