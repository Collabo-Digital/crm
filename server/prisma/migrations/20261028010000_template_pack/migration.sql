-- AlterTable
ALTER TABLE "automations" ADD COLUMN     "activate_when_ready" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pack_key" TEXT;

-- AlterTable
ALTER TABLE "message_templates" ADD COLUMN     "library_template_name" TEXT,
ADD COLUMN     "pack_slot" TEXT,
ADD COLUMN     "pack_source" TEXT,
ADD COLUMN     "pack_version" INTEGER,
ADD COLUMN     "rejection_info" JSONB,
ADD COLUMN     "status_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "order_fulfillments" ADD COLUMN     "out_for_delivery_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "template_packs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "auto_activate" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stopped_reason" TEXT,
    "last_run_at" TIMESTAMP(3),
    "settings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_packs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "template_packs_organization_id_idx" ON "template_packs"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_packs_waba_id_key" ON "template_packs"("waba_id");

-- CreateIndex
CREATE UNIQUE INDEX "automations_organization_id_pack_key_key" ON "automations"("organization_id", "pack_key");

-- CreateIndex
CREATE INDEX "message_templates_organization_id_pack_slot_idx" ON "message_templates"("organization_id", "pack_slot");

-- AddForeignKey
ALTER TABLE "template_packs" ADD CONSTRAINT "template_packs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_packs" ADD CONSTRAINT "template_packs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
