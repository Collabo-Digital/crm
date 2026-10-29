-- WhatsApp calls answered and placed from the browser, and each person's call permission.
-- CreateEnum
CREATE TYPE "WhatsAppCallDirection" AS ENUM ('USER_INITIATED', 'BUSINESS_INITIATED');

-- CreateEnum
CREATE TYPE "WhatsAppCallStatus" AS ENUM ('RINGING', 'CONNECTING', 'ACTIVE', 'COMPLETED', 'MISSED', 'REJECTED', 'FAILED');

-- AlterTable
ALTER TABLE "channel_contacts" ADD COLUMN     "call_permission" TEXT,
ADD COLUMN     "call_permission_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "whatsapp_calls" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "contact_id" TEXT,
    "external_id" TEXT,
    "direction" "WhatsAppCallDirection" NOT NULL,
    "status" "WhatsAppCallStatus" NOT NULL DEFAULT 'RINGING',
    "offer_sdp" TEXT,
    "answer_sdp" TEXT,
    "agent_user_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "failure" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_calls_organization_id_status_idx" ON "whatsapp_calls"("organization_id", "status");

-- CreateIndex
CREATE INDEX "whatsapp_calls_conversation_id_idx" ON "whatsapp_calls"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_calls_channel_id_external_id_key" ON "whatsapp_calls"("channel_id", "external_id");

-- AddForeignKey
ALTER TABLE "whatsapp_calls" ADD CONSTRAINT "whatsapp_calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_calls" ADD CONSTRAINT "whatsapp_calls_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_calls" ADD CONSTRAINT "whatsapp_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_calls" ADD CONSTRAINT "whatsapp_calls_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
