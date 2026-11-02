import { z } from 'zod';

/**
 * Per-org inventory settings. Stored as `OrganizationSettings.inventorySettings`
 * (JSONB) and validated by this schema before any write. Adding a new field
 * here doesn't require a Prisma migration.
 */
export const InventorySettingsSchema = z.object({
  /**
   * Master switch for Inventory V1 warehousing (StockLevel buckets,
   * warehouses, receiving, pick/pack). NOT settable via the settings PATCH —
   * it flips only at the END of the `POST /inventory/enable` seed job so there
   * is never a window where both the legacy single-quantity path and the
   * bucket path write for the same org. Plan-gated to GROWTH/ADVANCE.
   */
  warehousingEnabled: z.boolean().default(false),

  /**
   * Set by the enable flow for an org with a connected Shopify store: its
   * Shopify locations are still to be linked the way they always were (the
   * primary to the default location, each other one to a warehouse of its
   * own). Cleared by the locations sync that does it, so a sync that fails
   * leaves the job to the next one instead of to the merchant. Never set by
   * the settings PATCH.
   */
  linkShopifyLocations: z.boolean().default(false),

  /**
   * When TRUE, confirmed stock receipts land in the QC bucket and need an
   * explicit "Complete QC" step (accepted → AVAILABLE, rejected → DAMAGED).
   * When FALSE (default), receipts go straight to AVAILABLE.
   */
  qcOnReceiving: z.boolean().default(false),

  /**
   * When TRUE (default), the pick station requires a product barcode scan per
   * unit; manual +/- entry is hidden. Orgs without scanner hardware can turn
   * this off to use manual quantity entry.
   */
  requireScanToPick: z.boolean().default(true),

  /**
   * SKU generation prefix, e.g. "9TH". Empty string (default) derives a
   * 3-letter prefix from the organization slug at generation time.
   */
  skuPrefix: z.string().max(10).default(''),

  /**
   * Next value of the org-scoped SKU sequence. Claimed atomically (raw JSONB
   * increment) by the generation endpoint — never edit by hand.
   */
  skuSequence: z.number().int().min(1).default(1),

  /** When TRUE, a receipt line's unitCost updates the variant's cost field. */
  updateCostOnReceipt: z.boolean().default(false),

  /**
   * When TRUE, barcodes this CRM generated (`barcodeSource = GENERATED`) are
   * included in Shopify product pushes.
   *
   * Default FALSE, and the default matters: the push serialises the whole
   * variant row, so without this gate an internal 6-digit code would land in
   * the merchant's Shopify `barcode` field on the next unrelated push —
   * detached from the action that caused it, and occupying the field a real
   * GTIN would later go in. Turning it on is a legitimate choice (Shopify POS
   * can then scan the same labels); it is just not one to make silently.
   *
   * Barcodes sourced from Shopify or typed by a person are always pushed —
   * this gate covers generated codes only.
   */
  pushGeneratedBarcodes: z.boolean().default(false),
});

export type InventorySettings = z.infer<typeof InventorySettingsSchema>;

/**
 * Patch schema — every field truly optional, without defaults (same
 * `.partial()` trap as the other settings domains: defaults in a patch would
 * silently reset unsent fields during the service-side merge).
 *
 * `warehousingEnabled` and `skuSequence` are deliberately ABSENT: the flag
 * flips only via the enable flow, the sequence only via atomic claim.
 */
export const UpdateInventorySettingsSchema = z.object({
  qcOnReceiving: z.boolean().optional(),
  requireScanToPick: z.boolean().optional(),
  /**
   * Policed here rather than on the read schema, so an existing stored value
   * that predates this rule cannot fail the parse and reset every other
   * inventory setting to its default (`parseInventorySettings` falls back
   * wholesale). Uppercased and trimmed, then held to letters and digits: the
   * generator joins SKU parts with "-", so a prefix containing a hyphen or a
   * space would produce an unparseable code. Empty clears it, which returns to
   * the slug-derived prefix.
   */
  skuPrefix: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .refine((value) => /^[A-Z0-9]{0,10}$/.test(value), {
      message:
        'SKU prefix must be up to 10 letters or digits, with no spaces or punctuation.',
    })
    .optional(),
  updateCostOnReceipt: z.boolean().optional(),
  pushGeneratedBarcodes: z.boolean().optional(),
});
export type UpdateInventorySettingsInput = z.infer<typeof UpdateInventorySettingsSchema>;

/** Apply schema defaults to an unknown value, or fall through to defaults. */
export function parseInventorySettings(value: unknown): InventorySettings {
  const result = InventorySettingsSchema.safeParse(value ?? {});
  return result.success ? result.data : InventorySettingsSchema.parse({});
}
