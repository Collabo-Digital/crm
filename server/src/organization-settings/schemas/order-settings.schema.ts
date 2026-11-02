import { z } from 'zod';

/**
 * Per-org order settings. Stored as `OrganizationSettings.orderSettings`
 * (JSONB) and validated by this schema before any write. Adding a new field
 * here doesn't require a Prisma migration.
 */
export const OrderSettingsSchema = z.object({
  /**
   * When TRUE, offline orders created in the CRM are automatically pushed to
   * the connected Shopify channel. When FALSE (default), offline orders stay
   * local until pushed manually or via the channels-page bulk Sync.
   */
  autoSyncToShopify: z.boolean().default(false),

  /**
   * When TRUE, a GST invoice is issued automatically for a Shopify order the
   * moment it reaches `financialStatus = PAID`.
   *
   * Governs the SHOPIFY path only. Offline orders already invoice inline in
   * `OrderService.createOfflineOrder` via the per-request `generateInvoice`
   * flag (which defaults to on), and they are written `PAID` at creation — so
   * they already behave as "invoice on payment". Gating them behind this
   * setting would silently stop invoices orgs get today.
   *
   * Default FALSE is the safe direction for three reasons:
   *   1. Invoice numbers are statutory and gapless. Turning this on starts
   *      consuming serials automatically, and an org that is not ready for
   *      that should have to opt in.
   *   2. It only takes effect on LIVE webhooks — never on the bulk backfill,
   *      which on first connect would otherwise invoice up to
   *      SHOPIFY_INITIAL_ORDER_WINDOW_DAYS of historical orders in one burst,
   *      all dated today.
   *   3. `Organization.gstEnabled` and a registered GSTIN are still required;
   *      without them the attempt soft-fails and only logs.
   *
   * Payment, not placement, is the trigger: invoicing at placement means every
   * abandoned or cancelled order burns a serial and leaves a CANCELLED invoice
   * in the sequence that gets filed.
   */
  autoInvoiceOnPayment: z.boolean().default(false),

  /**
   * When TRUE, a cash-on-delivery order is invoiced when it ships, instead of
   * waiting for payment. GST wants the tax invoice issued by the time the
   * goods leave, and a COD order is only paid after delivery, so invoicing it
   * on payment issues the invoice late (or never, if nobody marks it paid).
   * Its payment later finds the invoice and issues nothing more.
   *
   * Default FALSE for the same reason as above: it consumes serials, so an
   * org opts in. Applies to live Shopify fulfilments and to shipments made
   * in Collabo.
   */
  autoInvoiceCodOnShipping: z.boolean().default(false),
});

export type OrderSettings = z.infer<typeof OrderSettingsSchema>;

/**
 * Patch schema — every field truly optional, without defaults.
 *
 * Same trap as ProductSettings: `OrderSettingsSchema.partial()` would keep
 * the `.default(false)`, causing a PATCH that doesn't include
 * `autoSyncToShopify` to be canonicalized to `{ autoSyncToShopify: false }`
 * and silently overwriting a user's existing `true` during the service-side
 * merge. Explicit `.optional()` keeps unset keys unset.
 */
export const UpdateOrderSettingsSchema = z.object({
  autoSyncToShopify: z.boolean().optional(),
  autoInvoiceOnPayment: z.boolean().optional(),
  autoInvoiceCodOnShipping: z.boolean().optional(),
});
export type UpdateOrderSettingsInput = z.infer<typeof UpdateOrderSettingsSchema>;

/** Apply schema defaults to an unknown value, or fall through to defaults. */
export function parseOrderSettings(value: unknown): OrderSettings {
  const result = OrderSettingsSchema.safeParse(value ?? {});
  return result.success ? result.data : OrderSettingsSchema.parse({});
}
