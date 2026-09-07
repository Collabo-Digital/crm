-- Multi-currency: record the FX rate each order was booked at.
--
-- Orders are stored in the currency the channel sold in (`orders.currency`),
-- which for a Shopify store is the SHOP's currency. The organisation reports
-- in its own currency (`organizations.currency`). Until now every total simply
-- summed the two together, so an INR workspace with a USD store reported
-- "₹12,235.20" for ₹1,911.50 + $10,323.70 added at 1:1.
--
-- Shopify cannot supply this rate: its money fields only span presentment vs
-- shop currency, and the org currency is a Collabo concept the store knows
-- nothing about. The rate therefore comes from an external provider and is
-- pinned to the ORDER'S OWN DATE, not fetched live -- a figure for last July
-- has to come back the same every time it is asked for, and has to keep
-- agreeing with a GST return already filed on it.
--
-- Nullable on purpose. NULL means "rate not resolved yet" (provider was
-- unreachable, or the order predates the backfill). Consumers must exclude
-- NULL rather than default it to 1, because 1 is a real and very wrong answer.
--
-- Guarded with IF NOT EXISTS: this schema has known drift from its migration
-- history, so migrations here must be safe to re-apply.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "exchange_rate" DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS "base_currency" TEXT;

-- Orders already denominated in the org currency convert at exactly 1. Setting
-- them here means the backfill only has to call the rate provider for genuinely
-- foreign orders, and it keeps single-currency organisations fully populated
-- without any network call at all.
UPDATE "orders" o
SET "exchange_rate" = 1,
    "base_currency" = org."currency"
FROM "organizations" org
WHERE org."id" = o."organization_id"
  AND o."currency" = org."currency"
  AND o."exchange_rate" IS NULL;

-- Aggregates filter on (organization_id, currency) to find what still needs a
-- rate, and to group totals per currency.
CREATE INDEX IF NOT EXISTS "orders_organization_id_currency_idx"
  ON "orders" ("organization_id", "currency");
