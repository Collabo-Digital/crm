-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "inbox_settings" JSONB;

-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "inbox_last_assigned_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "automation_runs" ADD COLUMN     "waiting_for_reply" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "automation_runs_contact_id_waiting_for_reply_idx" ON "automation_runs"("contact_id", "waiting_for_reply");

