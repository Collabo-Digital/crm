-- WhatsApp groups (Cloud API Groups): the group, its participants and join requests;
-- a group's chat is a contact flagged is_group.
-- CreateEnum
CREATE TYPE "WhatsAppGroupStatus" AS ENUM ('CREATING', 'ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED', 'FAILED');

-- AlterTable
ALTER TABLE "channel_contacts" ADD COLUMN     "is_group" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "whatsapp_groups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "external_id" TEXT,
    "request_id" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "join_approval_mode" TEXT NOT NULL DEFAULT 'auto_approve',
    "invite_link" TEXT,
    "status" "WhatsAppGroupStatus" NOT NULL DEFAULT 'CREATING',
    "status_reason" TEXT,
    "participant_count" INTEGER NOT NULL DEFAULT 0,
    "contact_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_group_participants" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "wa_id" TEXT NOT NULL,
    "name" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "left_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_group_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_group_join_requests" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "wa_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "decided_by_user_id" TEXT,

    CONSTRAINT "whatsapp_group_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_groups_contact_id_key" ON "whatsapp_groups"("contact_id");

-- CreateIndex
CREATE INDEX "whatsapp_groups_organization_id_idx" ON "whatsapp_groups"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_groups_channel_id_external_id_key" ON "whatsapp_groups"("channel_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_groups_channel_id_request_id_key" ON "whatsapp_groups"("channel_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_group_participants_group_id_wa_id_key" ON "whatsapp_group_participants"("group_id", "wa_id");

-- CreateIndex
CREATE INDEX "whatsapp_group_join_requests_group_id_status_idx" ON "whatsapp_group_join_requests"("group_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_group_join_requests_group_id_external_id_key" ON "whatsapp_group_join_requests"("group_id", "external_id");

-- AddForeignKey
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_group_participants" ADD CONSTRAINT "whatsapp_group_participants_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "whatsapp_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_group_join_requests" ADD CONSTRAINT "whatsapp_group_join_requests_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "whatsapp_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
