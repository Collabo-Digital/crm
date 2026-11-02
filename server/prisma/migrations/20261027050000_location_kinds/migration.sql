-- Stock locations: Store or Warehouse, and the merchant's decision for each
-- Shopify location (share stock with a location, make a new one, or leave it
-- out). Every existing location becomes a Warehouse.

-- CreateEnum
CREATE TYPE "StockLocationKind" AS ENUM ('STORE', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "ShopifyLocationAction" AS ENUM ('LINK', 'CREATE', 'IGNORE');

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "kind" "StockLocationKind" NOT NULL DEFAULT 'WAREHOUSE';

-- CreateTable
CREATE TABLE "shopify_location_links" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "shopify_location_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "address" JSONB,
    "action" "ShopifyLocationAction",
    "warehouse_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_location_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shopify_location_links_organization_id_idx" ON "shopify_location_links"("organization_id");

-- CreateIndex
CREATE INDEX "shopify_location_links_warehouse_id_idx" ON "shopify_location_links"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_location_links_channel_id_shopify_location_id_key" ON "shopify_location_links"("channel_id", "shopify_location_id");

-- AddForeignKey
ALTER TABLE "shopify_location_links" ADD CONSTRAINT "shopify_location_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_location_links" ADD CONSTRAINT "shopify_location_links_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_location_links" ADD CONSTRAINT "shopify_location_links_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: stores connected before this keep the links the old sync made,
-- recorded as decided, so nothing already syncing turns into "needs linking".
-- The old sync created every linked location except the default one, so those
-- are recorded as created from Shopify and keep taking its names.
INSERT INTO "shopify_location_links"
    ("id", "organization_id", "channel_id", "shopify_location_id", "name", "is_primary", "is_active",
     "address", "action", "warehouse_id", "decided_at", "updated_at")
SELECT gen_random_uuid()::text, w."organization_id", c."id", w."shopify_location_id", w."name",
       COALESCE(c."metadata"->>'shopifyLocationId' = w."shopify_location_id", false), w."is_active",
       w."address",
       (CASE WHEN w."is_default" THEN 'LINK' ELSE 'CREATE' END)::"ShopifyLocationAction",
       w."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "warehouses" w
JOIN "channels" c
  ON c."organization_id" = w."organization_id"
 AND c."platform" = 'SHOPIFY'
 AND c."status" <> 'DISCONNECTED'
WHERE w."shopify_location_id" IS NOT NULL
ON CONFLICT ("channel_id", "shopify_location_id") DO NOTHING;
