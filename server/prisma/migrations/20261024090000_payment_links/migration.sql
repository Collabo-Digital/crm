-- Payment links paid into each merchant's own gateway account (Razorpay).
-- New tables only; nothing existing changes.

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('RAZORPAY');


-- CreateEnum
CREATE TYPE "PaymentLinkStatus" AS ENUM ('CREATED', 'PARTIALLY_PAID', 'PAID', 'EXPIRED', 'CANCELLED');


-- CreateTable
CREATE TABLE "payment_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "key_id" TEXT NOT NULL,
    "credentials" TEXT,
    "webhook_token" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "connected_by_id" TEXT,
    "last_webhook_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_accounts_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "payment_links" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "external_id" TEXT NOT NULL,
    "short_url" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "description" TEXT NOT NULL,
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'CREATED',
    "order_id" TEXT,
    "draft_order_id" TEXT,
    "customer_id" TEXT,
    "contact_id" TEXT,
    "conversation_id" TEXT,
    "automation_run_id" TEXT,
    "created_by_id" TEXT,
    "tag_on_paid" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "payment_id" TEXT,
    "payment_method" TEXT,
    "follow_up_error" TEXT,
    "followed_up_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE UNIQUE INDEX "payment_accounts_webhook_token_key" ON "payment_accounts"("webhook_token");


-- CreateIndex
CREATE UNIQUE INDEX "payment_accounts_organization_id_provider_key" ON "payment_accounts"("organization_id", "provider");


-- CreateIndex
CREATE UNIQUE INDEX "payment_links_reference_id_key" ON "payment_links"("reference_id");


-- CreateIndex
CREATE INDEX "payment_links_organization_id_created_at_idx" ON "payment_links"("organization_id", "created_at");


-- CreateIndex
CREATE INDEX "payment_links_order_id_idx" ON "payment_links"("order_id");


-- CreateIndex
CREATE INDEX "payment_links_draft_order_id_idx" ON "payment_links"("draft_order_id");


-- CreateIndex
CREATE INDEX "payment_links_conversation_id_idx" ON "payment_links"("conversation_id");


-- CreateIndex
CREATE INDEX "payment_links_status_expires_at_idx" ON "payment_links"("status", "expires_at");


-- CreateIndex
CREATE UNIQUE INDEX "payment_links_account_id_external_id_key" ON "payment_links"("account_id", "external_id");


-- AddForeignKey
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_draft_order_id_fkey" FOREIGN KEY ("draft_order_id") REFERENCES "draft_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

