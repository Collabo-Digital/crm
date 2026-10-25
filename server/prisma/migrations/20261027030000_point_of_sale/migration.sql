-- Point of sale: staff with PINs, payments per order (split and part-paid),
-- the counter activity log, and POS sales marked on orders.

-- CreateEnum
CREATE TYPE "PosStaffRole" AS ENUM ('CASHIER', 'MANAGER');

-- CreateEnum
CREATE TYPE "PosPaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'OTHER');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pos_sale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pos_staff_id" TEXT;

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "pos_settings" JSONB;

-- CreateTable
CREATE TABLE "pos_staff" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "PosStaffRole" NOT NULL DEFAULT 'CASHIER',
    "pin_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_payments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "method" "PosPaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "tendered" DECIMAL(12,2),
    "reference" TEXT,
    "pos_staff_id" TEXT,
    "received_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_activities" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pos_staff_id" TEXT,
    "approved_by_id" TEXT,
    "order_id" TEXT,
    "device_user_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_staff_organization_id_idx" ON "pos_staff"("organization_id");

-- CreateIndex
CREATE INDEX "order_payments_order_id_idx" ON "order_payments"("order_id");

-- CreateIndex
CREATE INDEX "order_payments_organization_id_created_at_idx" ON "order_payments"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "pos_activities_organization_id_created_at_idx" ON "pos_activities"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_organization_id_pos_sale_created_at_idx" ON "orders"("organization_id", "pos_sale", "created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_pos_staff_id_fkey" FOREIGN KEY ("pos_staff_id") REFERENCES "pos_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_staff" ADD CONSTRAINT "pos_staff_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_pos_staff_id_fkey" FOREIGN KEY ("pos_staff_id") REFERENCES "pos_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_activities" ADD CONSTRAINT "pos_activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_activities" ADD CONSTRAINT "pos_activities_pos_staff_id_fkey" FOREIGN KEY ("pos_staff_id") REFERENCES "pos_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_activities" ADD CONSTRAINT "pos_activities_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "pos_staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_activities" ADD CONSTRAINT "pos_activities_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
