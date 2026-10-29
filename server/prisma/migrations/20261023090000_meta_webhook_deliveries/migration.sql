-- Raw Meta webhook deliveries (WhatsApp, Messenger, Instagram).
--
-- The webhook endpoints store the body here and acknowledge at once; the
-- meta-inbound queue processes it afterwards. body_hash is unique because Meta
-- redelivers byte-identical bodies. Rows are pruned 14 days after receipt.


-- CreateTable
CREATE TABLE "meta_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payload" JSONB NOT NULL,
    "body_hash" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "meta_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_webhook_deliveries_body_hash_key" ON "meta_webhook_deliveries"("body_hash");

-- CreateIndex
CREATE INDEX "meta_webhook_deliveries_received_at_idx" ON "meta_webhook_deliveries"("received_at");

-- CreateIndex
CREATE INDEX "meta_webhook_deliveries_object_processed_at_idx" ON "meta_webhook_deliveries"("object", "processed_at");

