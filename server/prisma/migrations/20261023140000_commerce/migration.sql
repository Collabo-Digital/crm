-- AlterTable
ALTER TABLE "products" ADD COLUMN     "handle" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_gateways" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "checkouts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "token" TEXT,
    "recovery_url" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "first_name" TEXT,
    "customer_external_id" TEXT,
    "currency" TEXT,
    "total" DECIMAL(12,2),
    "items" JSONB NOT NULL DEFAULT '[]',
    "completed_at" TIMESTAMP(3),
    "abandoned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_items" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "content_hash" TEXT,
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkouts_channel_id_token_idx" ON "checkouts"("channel_id", "token");

-- CreateIndex
CREATE INDEX "checkouts_completed_at_abandoned_at_updated_at_idx" ON "checkouts"("completed_at", "abandoned_at", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "checkouts_channel_id_external_id_key" ON "checkouts"("channel_id", "external_id");

-- CreateIndex
CREATE INDEX "catalog_items_channel_id_status_idx" ON "catalog_items"("channel_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_channel_id_variant_id_key" ON "catalog_items"("channel_id", "variant_id");

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

