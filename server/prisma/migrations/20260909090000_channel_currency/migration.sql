-- Record the currency a sales channel trades in.
--
-- Product prices are bare decimals: nothing on Product, ProductVariant or
-- Channel said what currency they were in, so the catalogue was rendered in the
-- ORGANISATION's currency regardless of where it came from. A USD Shopify store
-- inside an INR workspace listed a $749.95 snowboard as "₹749.95".
--
-- The currency belongs on the Channel rather than the Product: a store has one
-- currency and every product in it shares that currency, so putting it on each
-- product would be the same fact repeated a thousand times, free to drift.
--
-- Backfilled from data already held rather than by calling Shopify: every
-- synced order carries the shop's own currency (the GraphQL query reads
-- `shopMoney`), so the orders on a channel are direct evidence of what that
-- channel trades in.
--
-- Guarded with IF NOT EXISTS: this schema has known drift from its migration
-- history, so migrations here must be safe to re-apply.

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "currency" TEXT;

-- Manual / in-store channels are priced in the organisation's own currency by
-- construction — OrderService creates offline orders with `org.currency`.
UPDATE "channels" c
SET "currency" = org."currency"
FROM "organizations" org
WHERE org."id" = c."organization_id"
  AND c."platform" = 'MANUAL'
  AND c."currency" IS NULL;

-- Every other channel: the currency its orders actually arrived in. Where a
-- channel somehow holds more than one, the most frequent wins — a channel has
-- exactly one shop currency, so a minority value is noise (a historical
-- re-denomination, or a test order), not a second answer.
UPDATE "channels" c
SET "currency" = top."currency"
FROM (
  SELECT DISTINCT ON (o."channel_id")
         o."channel_id" AS channel_id,
         o."currency"   AS currency
  FROM "orders" o
  WHERE o."channel_id" IS NOT NULL
    AND o."deleted_at" IS NULL
    AND o."currency" IS NOT NULL
  GROUP BY o."channel_id", o."currency"
  ORDER BY o."channel_id", COUNT(*) DESC
) top
WHERE c."id" = top.channel_id
  AND c."currency" IS NULL;
