-- Products pulled from Shopify never received a `metadata.shopifySync` record
-- (only a push wrote one), so the products table could not tell "synced" from
-- "never pushed", and local edits to an imported product were never flagged
-- OUT_OF_SYNC. The pull now stamps the record; this gives every existing
-- Shopify-channel product the same one.
--
-- `syncedAt` is Shopify's own last-updated time for the product, falling back
-- to the local row's, so "Synced 3d ago" means something rather than reading
-- as the moment this migration ran.
--
-- The timestamp columns are `timestamp` WITHOUT time zone holding UTC
-- wall-clock, so they are formatted as-is. `now()` is `timestamptz` and is
-- brought to the same shape first: mixing the two in one coalesce would
-- promote the plain columns through the session time zone and shift every
-- value by its offset on a non-UTC session.
--
-- Idempotent: only rows with no record at all are touched. A row with a
-- PENDING, FAILED or OUT_OF_SYNC record already carries real state.
--
-- A CRM-created product carries a `manual_<uuid>` placeholder id until its
-- first push rewrites it. Such a row should never sit on a Shopify channel,
-- but stamping one SYNCED would record a fake Shopify id and hide its
-- Publish button, so the placeholder is refused outright.
UPDATE "products" p
SET "metadata" = jsonb_set(
  coalesce(p."metadata", '{}'::jsonb),
  '{shopifySync}',
  jsonb_build_object(
    'status', 'SYNCED',
    'shopifyProductId', p."external_id",
    'syncedAt', to_char(
      coalesce(p."external_updated_at", p."updated_at", now() AT TIME ZONE 'UTC'),
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'attempts', 0
  )
)
FROM "channels" c
WHERE c."id" = p."channel_id"
  AND c."platform" = 'SHOPIFY'
  AND p."deleted_at" IS NULL
  AND p."external_id" NOT LIKE 'manual\_%'
  AND (p."metadata" IS NULL OR p."metadata" -> 'shopifySync' IS NULL);
