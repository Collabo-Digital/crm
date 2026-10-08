import { Prisma } from '@prisma/client';

/**
 * SYNCED → OUT_OF_SYNC, for products whose local copy now differs from Shopify.
 *
 * `metadata.shopifySync.status` is the only thing "Sync Now" reads to decide
 * what to push: `bulkPushManualProducts` pushes OUT_OF_SYNC / FAILED products
 * and skips SYNCED ones. So a local write that never flips the status is a
 * write Shopify never hears about. The bulk code generators were exactly that
 * for two months: on 2026-10-08 Shrishti had 4,308 generated barcodes, the
 * "send generated barcodes" setting on, and two Sync Now runs that each logged
 * "no products pending" — because every product still read SYNCED.
 *
 * Only a SYNCED row is touched. The other states belong to someone else:
 *   - no record: a MANUAL-channel product that has never been pushed. The
 *     push sweep already picks those up by the absence of a record, and a
 *     stamp here would make it look like a rebadged Shopify product.
 *   - PENDING: a push job owns the row until it reports.
 *   - OUT_OF_SYNC / FAILED: already flagged, and FAILED carries the error the
 *     merchant has not yet seen.
 *
 * One atomic statement per call, like `pulledProductSyncedStampSql`: the
 * guard and the merge happen in the same UPDATE. `||` keeps the rest of the
 * record (shopifyProductId, syncedAt, attempts) so the pill can still say when
 * it was last in sync.
 */
export function productsOutOfSyncStampSql(productIds: string[]): Prisma.Sql {
  return Prisma.sql`
    UPDATE "products"
    SET "metadata" = jsonb_set(
      coalesce("metadata", '{}'::jsonb),
      '{shopifySync}',
      coalesce("metadata" -> 'shopifySync', '{}'::jsonb) || '{"status": "OUT_OF_SYNC"}'::jsonb
    )
    WHERE "id" = ANY(${productIds}::text[])
      AND "metadata" -> 'shopifySync' ->> 'status' = 'SYNCED'
  `;
}

/**
 * The org-wide form, for the moment `inventorySettings.pushGeneratedBarcodes`
 * is switched on.
 *
 * The flag changes what a *future* push sends; it does not by itself make any
 * product need one. Without this, every generated barcode minted while the
 * flag was off stays local for ever — nothing else ever re-flags those rows,
 * and the pull that Sync Now runs first re-stamps them SYNCED anyway. Flagging
 * them here is the contract of the toggle: "send generated barcodes" means
 * "there is now something to send".
 *
 * A product qualifies when at least one variant carries a GENERATED barcode.
 * MANUAL and SHOPIFY codes are pushed regardless of the flag, so flipping it
 * changes nothing for them.
 */
export function generatedBarcodeProductsOutOfSyncStampSql(orgId: string): Prisma.Sql {
  return Prisma.sql`
    UPDATE "products" p
    SET "metadata" = jsonb_set(
      coalesce(p."metadata", '{}'::jsonb),
      '{shopifySync}',
      coalesce(p."metadata" -> 'shopifySync', '{}'::jsonb) || '{"status": "OUT_OF_SYNC"}'::jsonb
    )
    WHERE p."organization_id" = ${orgId}
      AND p."deleted_at" IS NULL
      AND p."metadata" -> 'shopifySync' ->> 'status' = 'SYNCED'
      AND EXISTS (
        SELECT 1 FROM "product_variants" v
         WHERE v."product_id" = p."id"
           AND v."barcode_source" = 'GENERATED'
           AND v."barcode" IS NOT NULL
           AND v."barcode" <> ''
      )
  `;
}
