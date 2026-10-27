import { z } from 'zod';

/**
 * The merchant's own business identity — the "From" half of a package slip,
 * and the contact block printed under it.
 *
 * This exists because there was nowhere else for it. `Organization` carries
 * `name`, `website` and `logo` and nothing more: no address, no phone, no
 * support email, and no UI that ever writes `logo`. The packing slip therefore
 * shipped with a free-text "Company name" box saved to the operator's own
 * localStorage, which every operator had to retype and which no invoice or
 * email could ever read.
 *
 * Stored as `OrganizationSettings.storeProfileSettings` (JSONB) and validated
 * here before any write, so adding a field later needs no migration.
 *
 * Kept FLAT, like its sibling domains: the service merges with a shallow
 * spread, so a nested object would be replaced wholesale and a partial PATCH
 * would silently drop sibling keys.
 *
 * The address keys are deliberately the app's CANONICAL set (address1,
 * address2, city, province, zip, country) — the same ones
 * `OrganizationGstin.address`, `Warehouse.address` and the client's
 * `readAddress()` use. That is what lets the slip fall back from this profile
 * to the dispatch warehouse to the default GSTIN without a translation layer.
 */
export const StoreProfileSettingsSchema = z.object({
  /**
   * Trading name shown on the slip. Empty means "fall back to
   * Organization.name", which is what every org gets before it fills this in.
   */
  storeName: z.string().default(''),

  address1: z.string().default(''),
  address2: z.string().default(''),
  city: z.string().default(''),
  province: z.string().default(''),
  zip: z.string().default(''),
  country: z.string().default(''),

  /** Printed in the slip's contact row. Free-form: formats vary by country. */
  supportPhone: z.string().default(''),
  /**
   * Separate from `supportPhone` because merchants routinely publish a
   * different number for WhatsApp, and the sample slip prints both.
   */
  whatsappPhone: z.string().default(''),
  supportEmail: z.string().default(''),

  /** Empty falls back to `Organization.website`. */
  website: z.string().default(''),
  /**
   * Absolute URL. There is no upload pipeline for this yet, so it is a URL
   * field rather than a file — the slip renders it in an <img> and silently
   * drops to the wordmark when it is empty or fails to load.
   */
  logoUrl: z.string().default(''),
  /**
   * The stored file behind `logoUrl` when the logo was uploaded rather than
   * typed in. Set and cleared only by the logo upload route, never by PATCH.
   * PDFs embed only an uploaded logo: the server never fetches a URL a member
   * typed, and a typed one prints the trading name instead.
   */
  logoStorageKey: z.string().default(''),
});

export type StoreProfileSettings = z.infer<typeof StoreProfileSettingsSchema>;

/**
 * Blank is always allowed — every field here is optional business info, and a
 * merchant clearing one must not be blocked by a format rule meant for a
 * filled-in value. Only non-empty input is held to the format.
 */
const optionalEmail = z
  .string()
  .trim()
  .refine((v) => v === '' || z.string().email().safeParse(v).success, {
    message: 'Enter a valid email address, or leave it blank.',
  })
  .optional();

const optionalUrl = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), {
    message: 'Enter a full URL starting with http:// or https://, or leave it blank.',
  })
  .optional();

/**
 * Patch schema — every field truly optional, WITHOUT defaults.
 *
 * Same trap as the other four domains: `.partial()` would keep each
 * `.default('')`, so a PATCH that only set `storeName` would be canonicalised
 * to carry `address1: ''` and wipe the merchant's address during the
 * service-side merge. Explicit `.optional()` keeps unset keys unset.
 */
export const UpdateStoreProfileSettingsSchema = z.object({
  storeName: z.string().trim().max(120).optional(),
  address1: z.string().trim().max(200).optional(),
  address2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  province: z.string().trim().max(100).optional(),
  zip: z.string().trim().max(20).optional(),
  country: z.string().trim().max(100).optional(),
  supportPhone: z.string().trim().max(40).optional(),
  whatsappPhone: z.string().trim().max(40).optional(),
  supportEmail: optionalEmail,
  website: optionalUrl,
  logoUrl: optionalUrl,
});
export type UpdateStoreProfileSettingsInput = z.infer<
  typeof UpdateStoreProfileSettingsSchema
>;

/**
 * Apply schema defaults to an unknown value, or fall through to defaults.
 *
 * `safeParse`, like its siblings: this is read on every slip print, and a
 * corrupt stored blob should degrade to blanks (and therefore to the
 * Organization fallbacks) rather than throw and take the print route down.
 */
export function parseStoreProfileSettings(value: unknown): StoreProfileSettings {
  const result = StoreProfileSettingsSchema.safeParse(value ?? {});
  return result.success ? result.data : StoreProfileSettingsSchema.parse({});
}
