-- Reviews collected on WhatsApp, and the review app (Judge.me) each organization publishes them to.
-- CreateEnum
CREATE TYPE "ReviewProvider" AS ENUM ('JUDGEME');

-- CreateEnum
CREATE TYPE "ProductReviewStatus" AS ENUM ('POSTED', 'SAVED', 'FAILED');

-- CreateTable
CREATE TABLE "review_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" "ReviewProvider" NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shop_name" TEXT,
    "autopublish" BOOLEAN,
    "connected_by_id" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_reviews" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT,
    "conversation_id" TEXT,
    "contact_id" TEXT,
    "automation_run_id" TEXT,
    "product_external_id" TEXT,
    "product_title" TEXT,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "reviewer_name" TEXT NOT NULL,
    "reviewer_email" TEXT,
    "provider" "ReviewProvider",
    "status" "ProductReviewStatus" NOT NULL,
    "reason" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_accounts_organization_id_provider_key" ON "review_accounts"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "product_reviews_organization_id_created_at_idx" ON "product_reviews"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "product_reviews_order_id_idx" ON "product_reviews"("order_id");

-- AddForeignKey
ALTER TABLE "review_accounts" ADD CONSTRAINT "review_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
