-- Unified messaging core: richer message kinds and authorship, WhatsApp
-- contact identity that survives hidden phone numbers (BSUID + wa_id), contact
-- tags/attributes/consent, conversation lifecycle columns, team-only notes and
-- the consent audit trail.
--
-- Requires PostgreSQL 12+ (several enum values added in one migration).


-- CreateEnum
CREATE TYPE "MessageSource" AS ENUM ('CUSTOMER', 'AGENT', 'AUTOMATION', 'BROADCAST', 'BUSINESS_APP', 'OTHER_APP', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('OPT_IN', 'OPT_OUT');

-- AlterEnum


ALTER TYPE "MessageKind" ADD VALUE 'VIDEO';
ALTER TYPE "MessageKind" ADD VALUE 'AUDIO';
ALTER TYPE "MessageKind" ADD VALUE 'STICKER';
ALTER TYPE "MessageKind" ADD VALUE 'LOCATION';
ALTER TYPE "MessageKind" ADD VALUE 'CONTACTS';
ALTER TYPE "MessageKind" ADD VALUE 'INTERACTIVE';
ALTER TYPE "MessageKind" ADD VALUE 'REACTION';
ALTER TYPE "MessageKind" ADD VALUE 'PRODUCT';
ALTER TYPE "MessageKind" ADD VALUE 'ORDER';
ALTER TYPE "MessageKind" ADD VALUE 'SYSTEM';
ALTER TYPE "MessageKind" ADD VALUE 'UNSUPPORTED';
ALTER TYPE "MessageKind" ADD VALUE 'COMMENT';

-- AlterTable
ALTER TABLE "channel_contacts" ADD COLUMN     "address_book_name" TEXT,
ADD COLUMN     "attributes" JSONB,
ADD COLUMN     "blocked_at" TIMESTAMP(3),
ADD COLUMN     "opt_in_at" TIMESTAMP(3),
ADD COLUMN     "opt_in_source" TEXT,
ADD COLUMN     "previous_external_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "wa_id" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "awaiting_reply_since" TIMESTAMP(3),
ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "closed_by_id" TEXT,
ADD COLUMN     "first_response_at" TIMESTAMP(3),
ADD COLUMN     "last_agent_reply_at" TIMESTAMP(3),
ADD COLUMN     "snoozed_until" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "edited_at" TIMESTAMP(3),
ADD COLUMN     "imported" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "media" JSONB,
ADD COLUMN     "pricing" JSONB,
ADD COLUMN     "reactions" JSONB,
ADD COLUMN     "reply_to_external_id" TEXT,
ADD COLUMN     "reply_to_message_id" TEXT,
ADD COLUMN     "revoked_at" TIMESTAMP(3),
ADD COLUMN     "sent_by_user_id" TEXT,
ADD COLUMN     "source" "MessageSource";

-- CreateTable
CREATE TABLE "consent_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "type" "ConsentType" NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" JSONB,
    "actor_user_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_notes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "author_user_id" TEXT,
    "body" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consent_events_contact_id_occurred_at_idx" ON "consent_events"("contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "consent_events_organization_id_occurred_at_idx" ON "consent_events"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "conversation_notes_conversation_id_created_at_idx" ON "conversation_notes"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "channel_contacts_channel_id_wa_id_idx" ON "channel_contacts"("channel_id", "wa_id");

-- CreateIndex
CREATE INDEX "conversations_organization_id_assigned_user_id_status_idx" ON "conversations"("organization_id", "assigned_user_id", "status");

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

