-- Ads: referrals from click-to-message ads, the Meta ad account, and the
-- conversions sent to Meta. New tables only; nothing existing changes.

-- CreateTable
CREATE TABLE "ad_referrals" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "platform" "ChannelPlatform" NOT NULL,
    "contact_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "ad_id" TEXT NOT NULL,
    "headline" TEXT,
    "body" TEXT,
    "source_url" TEXT,
    "media_url" TEXT,
    "ctwa_clid" TEXT,
    "ref" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_referrals_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "ad_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "external_id" TEXT,
    "name" TEXT,
    "currency" TEXT,
    "credentials" TEXT NOT NULL,
    "available" JSONB NOT NULL DEFAULT '[]',
    "token_expires_at" TIMESTAMP(3),
    "connected_by_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_accounts_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "conversion_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "payment_link_id" TEXT,
    "order_id" TEXT,
    "event_name" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "ctwa_clid" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE UNIQUE INDEX "ad_referrals_message_id_key" ON "ad_referrals"("message_id");


-- CreateIndex
CREATE INDEX "ad_referrals_organization_id_occurred_at_idx" ON "ad_referrals"("organization_id", "occurred_at");


-- CreateIndex
CREATE INDEX "ad_referrals_organization_id_ad_id_idx" ON "ad_referrals"("organization_id", "ad_id");


-- CreateIndex
CREATE INDEX "ad_referrals_contact_id_occurred_at_idx" ON "ad_referrals"("contact_id", "occurred_at");


-- CreateIndex
CREATE UNIQUE INDEX "ad_accounts_organization_id_key" ON "ad_accounts"("organization_id");


-- CreateIndex
CREATE INDEX "conversion_events_organization_id_created_at_idx" ON "conversion_events"("organization_id", "created_at");


-- CreateIndex
CREATE UNIQUE INDEX "conversion_events_payment_link_id_event_name_key" ON "conversion_events"("payment_link_id", "event_name");


-- AddForeignKey
ALTER TABLE "ad_referrals" ADD CONSTRAINT "ad_referrals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

