-- WhatsApp Pay requests reuse payment_links: no Razorpay account, but the
-- WhatsApp number and its payment configuration. New nullable columns only.

ALTER TYPE "PaymentProvider" ADD VALUE 'WHATSAPP_PAY';

ALTER TABLE "payment_links" ALTER COLUMN "account_id" DROP NOT NULL;
ALTER TABLE "payment_links" ADD COLUMN "channel_id" TEXT;
ALTER TABLE "payment_links" ADD COLUMN "payment_configuration" TEXT;

CREATE INDEX "payment_links_channel_id_idx" ON "payment_links"("channel_id");

ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
