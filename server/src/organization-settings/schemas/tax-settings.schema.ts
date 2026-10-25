import { z } from 'zod';
import { DEFAULT_UQC, UQC_CODES } from '../../gst/constants/uqc';
import {
  CREDIT_NOTE_PREFIX,
  DEFAULT_INVOICE_PREFIX,
  SERIES_PREFIX_REGEX,
} from '../../invoice/invoice-number.util';

/**
 * Per-org GST/tax settings. Stored as `OrganizationSettings.taxSettings`
 * (JSONB) and validated by this schema before any write. Adding a new field
 * here doesn't require a Prisma migration.
 *
 * Kept FLAT on purpose: `OrganizationSettingsService.updateTaxSettings` merges
 * with a shallow spread, so a nested object would be replaced wholesale rather
 * than deep-merged and a partial PATCH would silently drop sibling keys.
 */
export const TaxSettingsSchema = z.object({
  /**
   * Invoice value at or below which an inter-state B2C supply is reported in
   * GSTR-1 Table 7 (B2CS, summarised) rather than Table 5 (B2CL, invoice-wise).
   *
   * ₹1,00,000 is the statutory figure since November 2024, reduced from the
   * earlier ₹2,50,000. It is a setting rather than a constant because the
   * threshold has already moved once and a merchant's accountant may be filing
   * against the older limit for a prior period.
   *
   * Compared against invoice VALUE (grand total), not taxable value.
   */
  b2cLargeThreshold: z.number().positive().default(100000),

  /**
   * UQC used for GSTR-1 Table 12 rows when a product does not specify one.
   *
   * Table 12 requires a unit on every row and nothing in the catalogue carries
   * one today, so without a default every row would be invalid. NOS ("numbers")
   * fits anything sold by count.
   */
  defaultUnitOfMeasure: z.enum(UQC_CODES).default(DEFAULT_UQC),

  /**
   * Tax delivery charges as a COMPOSITE SUPPLY, at the principal supply's rate.
   *
   * Correct under Indian GST — delivery on a taxable supply normally takes the
   * goods' rate — and until now shipping was added to the grand total untaxed,
   * so every shipped order under-declared output tax.
   *
   * ⚠️ DEFAULT OFF, and this is the only setting in the module that changes tax
   * charged on a real transaction. For a Shopify order the customer was already
   * charged at checkout, so turning this on before the store's own shipping-tax
   * setting matches makes the invoice declare MORE than was collected. That
   * shows up correctly as a reconciliation mismatch, but it is a surprise worth
   * opting into rather than inheriting.
   */
  taxShipping: z.boolean().default(false),

  /**
   * Series prefix for invoice numbers — `SJ` gives `SJ-26-27/000001`.
   *
   * Lenient here on purpose: this is the READ schema, and a stored value that
   * no longer validates must degrade to the default rather than fail the parse
   * and take every other tax setting down with it (`parseTaxSettings` falls
   * back wholesale). `resolveInvoicePrefix` sanitises at the point of use, and
   * `UpdateTaxSettingsSchema` is where input is actually policed.
   *
   * ⚠️ Changing this starts a NEW consecutive run at 000001, because the next
   * number is read back per prefix. Multiple series are permitted under GST as
   * long as each is consecutive, so that is legitimate — but it is a visible
   * change and the settings screen says so before saving.
   */
  invoicePrefix: z.string().default(DEFAULT_INVOICE_PREFIX),

  /**
   * "Catalogue prices include GST": a product's price, or one typed into an
   * order, already contains the tax, so GST is backed out of it rather than
   * added on top. Null until the merchant chooses; until then the store's own
   * Shopify orders decide (see `catalogPricesIncludeTax`).
   */
  pricesIncludeTax: z.boolean().nullable().default(null),
});

export type TaxSettings = z.infer<typeof TaxSettingsSchema>;

/**
 * Patch schema — every field truly optional, without defaults.
 *
 * Same trap as OrderSettings and ProductSettings: `TaxSettingsSchema.partial()`
 * would KEEP the `.default(...)` on each field, so a PATCH that only sets
 * `defaultUnitOfMeasure` would be canonicalized to also carry
 * `b2cLargeThreshold: 100000` and silently reset a merchant's configured
 * threshold during the service-side merge. Explicit `.optional()` keeps unset
 * keys unset. `tax-settings.schema.spec.ts` guards this directly.
 */
export const UpdateTaxSettingsSchema = z.object({
  b2cLargeThreshold: z.number().positive().optional(),
  defaultUnitOfMeasure: z.enum(UQC_CODES).optional(),
  taxShipping: z.boolean().optional(),
  /**
   * Policed here rather than on the read schema. Uppercased and trimmed so
   * "sj " is accepted, then held to letters and digits only — a hyphen or
   * slash would collide with the separators the sequence reader splits on —
   * and to three characters, which is what is left of Rule 46(b)'s sixteen
   * once the year and the padded sequence are accounted for.
   */
  invoicePrefix: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .refine((value) => SERIES_PREFIX_REGEX.test(value), {
      message:
        'Invoice prefix must be 1 to 3 letters or digits, with no spaces or punctuation.',
    })
    .refine((value) => value !== CREDIT_NOTE_PREFIX, {
      message:
        `"${CREDIT_NOTE_PREFIX}" is reserved for credit notes. Sharing it would merge the two ` +
        'numbering series and break the consecutive invoice run.',
    })
    .optional(),
  pricesIncludeTax: z.boolean().optional(),
});
export type UpdateTaxSettingsInput = z.infer<typeof UpdateTaxSettingsSchema>;

/**
 * Apply schema defaults to an unknown value, or fall through to defaults.
 *
 * `safeParse` rather than `parse`: this runs on the GST return hot path, and a
 * corrupt stored blob should degrade to defaults rather than throw and take the
 * whole return down with it.
 */
export function parseTaxSettings(value: unknown): TaxSettings {
  const result = TaxSettingsSchema.safeParse(value ?? {});
  return result.success ? result.data : TaxSettingsSchema.parse({});
}
