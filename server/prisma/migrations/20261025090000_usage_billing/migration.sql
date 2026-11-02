-- Usage billing: the conversation meter, monthly usage counts and the bills for usage over a plan's allowance.
-- CreateEnum
CREATE TYPE "UsageBillStatus" AS ENUM ('PROCESSING', 'NOTHING_DUE', 'ADDED', 'LINK_SENT', 'PAID', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "channel_contacts" ADD COLUMN     "usage_window_ends_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "billing_currency" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pending_billing_currency" TEXT;

-- CreateTable
CREATE TABLE "usage_months" (
    "organization_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "conversations" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_months_pkey" PRIMARY KEY ("organization_id","period")
);

-- CreateTable
CREATE TABLE "usage_bills" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" "UsageBillStatus" NOT NULL DEFAULT 'PROCESSING',
    "plan" "BillingPlan",
    "currency" TEXT,
    "usage" JSONB,
    "lines" JSONB,
    "subtotal" INTEGER,
    "tax" INTEGER,
    "total" INTEGER,
    "external_id" TEXT,
    "payment_url" TEXT,
    "note" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_bills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_bills_status_idx" ON "usage_bills"("status");

-- CreateIndex
CREATE UNIQUE INDEX "usage_bills_organization_id_period_key" ON "usage_bills"("organization_id", "period");

-- AddForeignKey
ALTER TABLE "usage_months" ADD CONSTRAINT "usage_months_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_bills" ADD CONSTRAINT "usage_bills_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
