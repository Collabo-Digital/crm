-- Order packing assistant: the unused pick tasks become packing tasks, plus a
-- per-task event log. Packing checks what goes into the parcel; it never moves
-- stock, creates a shipment or calls Shopify.
--
-- Nothing has ever written pick_tasks / pick_task_lines, so the new NOT NULL
-- columns only carry defaults to keep this safe on any database.

-- AlterTable: an order may have no dispatch location.
ALTER TABLE "pick_tasks" ALTER COLUMN "warehouse_id" DROP NOT NULL,
ADD COLUMN     "hold_reason" TEXT,
ADD COLUMN     "hold_note" TEXT,
ADD COLUMN     "held_at" TIMESTAMP(3),
ADD COLUMN     "held_by" TEXT,
ADD COLUMN     "packed_by" TEXT,
ADD COLUMN     "partial" BOOLEAN NOT NULL DEFAULT false;

-- Only one PACKING or ON_HOLD task per order. PACKED and CANCELLED tasks stay
-- as the record, and a new task may follow them.
DROP INDEX IF EXISTS "pick_tasks_order_id_open_key";
CREATE UNIQUE INDEX "pick_tasks_order_id_open_key"
  ON "pick_tasks"("order_id")
  WHERE "status" IN ('PACKING', 'ON_HOLD');

-- AlterTable: custom lines have no variant and are confirmed by hand.
ALTER TABLE "pick_task_lines" ALTER COLUMN "variant_id" DROP NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "variant_title" TEXT,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "qty_hand_confirmed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "qty_counted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "problem_reason" TEXT,
ADD COLUMN     "problem_qty" INTEGER NOT NULL DEFAULT 0;

-- qty_picked is everything packed (scanned + hand-confirmed + counted) and can
-- never pass what the order needs, however many packers scan at once.
ALTER TABLE "pick_task_lines"
  ADD CONSTRAINT "pick_task_lines_qty_picked_max" CHECK ("qty_picked" <= "qty_required"),
  ADD CONSTRAINT "pick_task_lines_qty_split" CHECK (
    "qty_hand_confirmed" >= 0 AND "qty_counted" >= 0
    AND "qty_hand_confirmed" + "qty_counted" <= "qty_picked"
  ),
  ADD CONSTRAINT "pick_task_lines_problem_qty_nonneg" CHECK ("problem_qty" >= 0);

-- One task line per order line: two packers opening the same order at once
-- must not both add a line the order gained.
CREATE UNIQUE INDEX "pick_task_lines_pick_task_id_order_line_item_id_key" ON "pick_task_lines"("pick_task_id", "order_line_item_id");

-- CreateTable
CREATE TABLE "pick_task_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "pick_task_id" TEXT NOT NULL,
    "pick_task_line_id" TEXT,
    "actor_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "client_scan_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pick_task_events_pkey" PRIMARY KEY ("id")
);

-- A retried request (same client_scan_id) finds the first one's row and
-- changes nothing. NULLs never collide, so events without an id are free.
CREATE UNIQUE INDEX "pick_task_events_pick_task_id_client_scan_id_key" ON "pick_task_events"("pick_task_id", "client_scan_id");

-- CreateIndex
CREATE INDEX "pick_task_events_organization_id_created_at_idx" ON "pick_task_events"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "pick_task_events" ADD CONSTRAINT "pick_task_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pick_task_events" ADD CONSTRAINT "pick_task_events_pick_task_id_fkey" FOREIGN KEY ("pick_task_id") REFERENCES "pick_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pick_task_events" ADD CONSTRAINT "pick_task_events_pick_task_line_id_fkey" FOREIGN KEY ("pick_task_line_id") REFERENCES "pick_task_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
