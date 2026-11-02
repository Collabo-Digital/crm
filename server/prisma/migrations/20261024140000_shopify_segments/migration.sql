-- Shopify customer segments linked for broadcast audiences, and their members.
-- New tables only; nothing existing changes.

-- CreateTable
CREATE TABLE "shopify_segments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT,
    "member_count" INTEGER,
    "matched_count" INTEGER,
    "synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_segments_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "shopify_segment_members" (
    "segment_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_segment_members_pkey" PRIMARY KEY ("segment_id","customer_id")
);


-- CreateIndex
CREATE INDEX "shopify_segments_organization_id_idx" ON "shopify_segments"("organization_id");


-- CreateIndex
CREATE UNIQUE INDEX "shopify_segments_channel_id_external_id_key" ON "shopify_segments"("channel_id", "external_id");


-- CreateIndex
CREATE INDEX "shopify_segment_members_customer_id_idx" ON "shopify_segment_members"("customer_id");


-- AddForeignKey
ALTER TABLE "shopify_segments" ADD CONSTRAINT "shopify_segments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "shopify_segments" ADD CONSTRAINT "shopify_segments_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "shopify_segment_members" ADD CONSTRAINT "shopify_segment_members_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "shopify_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "shopify_segment_members" ADD CONSTRAINT "shopify_segment_members_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

