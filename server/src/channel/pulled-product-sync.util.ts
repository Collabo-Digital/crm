import { Prisma } from '@prisma/client';

/**
 * The sync stamp a Shopify PULL leaves on a product.
 *
 * A pull never used to write `metadata.shopifySync`, only a push did. So an
 * imported product carried no record at all, `markOutOfSyncIfNeeded` (which
 * only flips SYNCED → OUT_OF_SYNC) ignored its local edits, and the products
 * table could neither say "Synced" nor know there was something to push.
 *
 * Only a row with NO record, or one already SYNCED (its `syncedAt` moves to
 * the pull time), is touched. Every other state is the merchant's, not the
 * pull's, to clear:
 *   - PENDING: a push job owns the row until it reports success or failure;
 *     stamping it here would race the job's own write.
 *   - OUT_OF_SYNC / FAILED: the pull does overwrite the local copy with
 *     Shopify's, but that overwrite is itself the open "sync reverts CRM
 *     edits" problem, and the amber or red pill is the only sign the merchant
 *     has that their edits existed. A `products/update` webhook for an
 *     unrelated change (an inventory move, say) must not erase it. Their
 *     own Push / Retry resolves the state through the push's writes.
 *
 * One atomic statement: the guard and the merge happen in the same UPDATE, so
 * a claim taken between a read and a write cannot be clobbered. The NULL
 * handling is deliberate — a Prisma JSON-path filter on a row with no
 * `shopifySync` key is NULL, and `NOT (NULL)` is NULL, which would exclude
 * precisely the never-stamped rows this exists for.
 */
export function pulledProductSyncedStampSql(
  productId: string,
  shopifyProductId: string,
  now: Date = new Date(),
): Prisma.Sql {
  return Prisma.sql`
    UPDATE "products"
    SET "metadata" = jsonb_set(
      coalesce("metadata", '{}'::jsonb),
      '{shopifySync}',
      coalesce("metadata" -> 'shopifySync', '{}'::jsonb) || jsonb_build_object(
        'status', 'SYNCED',
        'shopifyProductId', ${shopifyProductId}::text,
        'syncedAt', ${now.toISOString()}::text,
        'attempts', coalesce(("metadata" -> 'shopifySync' ->> 'attempts')::int, 0)
      )
    )
    WHERE "id" = ${productId}
      AND coalesce("metadata" -> 'shopifySync' ->> 'status', 'NONE') IN ('NONE', 'SYNCED')
  `;
}
