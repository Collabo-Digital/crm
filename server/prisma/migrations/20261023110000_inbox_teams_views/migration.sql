-- CreateEnum
CREATE TYPE "InboxAvailability" AS ENUM ('ONLINE', 'AWAY');

-- CreateEnum
CREATE TYPE "InboxShareScope" AS ENUM ('PERSONAL', 'TEAM', 'ORGANIZATION');

-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "inbox_seen_at" TIMESTAMP(3),
ADD COLUMN     "inbox_status" "InboxAvailability" NOT NULL DEFAULT 'ONLINE';

-- AlterTable
ALTER TABLE "channel_contacts" ADD COLUMN     "owner_team_id" TEXT,
ADD COLUMN     "owner_user_id" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "team_id" TEXT;

-- CreateTable
CREATE TABLE "inbox_teams" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_team_members" (
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_team_members_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "quick_replies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attachment" JSONB,
    "scope" "InboxShareScope" NOT NULL DEFAULT 'ORGANIZATION',
    "team_id" TEXT,
    "owner_user_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quick_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_views" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "scope" "InboxShareScope" NOT NULL DEFAULT 'PERSONAL',
    "team_id" TEXT,
    "owner_user_id" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbox_teams_organization_id_name_key" ON "inbox_teams"("organization_id", "name");

-- CreateIndex
CREATE INDEX "inbox_team_members_user_id_idx" ON "inbox_team_members"("user_id");

-- CreateIndex
CREATE INDEX "quick_replies_organization_id_shortcut_idx" ON "quick_replies"("organization_id", "shortcut");

-- CreateIndex
CREATE INDEX "inbox_views_organization_id_idx" ON "inbox_views"("organization_id");

-- CreateIndex
CREATE INDEX "channel_contacts_organization_id_created_at_idx" ON "channel_contacts"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "conversations_organization_id_team_id_status_idx" ON "conversations"("organization_id", "team_id", "status");

-- AddForeignKey
ALTER TABLE "channel_contacts" ADD CONSTRAINT "channel_contacts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_contacts" ADD CONSTRAINT "channel_contacts_owner_team_id_fkey" FOREIGN KEY ("owner_team_id") REFERENCES "inbox_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "inbox_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_teams" ADD CONSTRAINT "inbox_teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_team_members" ADD CONSTRAINT "inbox_team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "inbox_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_team_members" ADD CONSTRAINT "inbox_team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "inbox_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_views" ADD CONSTRAINT "inbox_views_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_views" ADD CONSTRAINT "inbox_views_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "inbox_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

