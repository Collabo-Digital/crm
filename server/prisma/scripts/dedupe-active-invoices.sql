-- Cancel duplicate ACTIVE GST invoices so that at most one live invoice
-- remains per order.
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 20260729130000_one_active_invoice_per_order creates
--   UNIQUE invoices(order_id) WHERE status <> 'CANCELLED'
-- Its pre-flight was verified on the dev database only. A long-lived
-- deployment that ran the pre-guard build carries historical duplicates
-- (double-submits / retries from before createForOrderTx checked for an
-- existing live invoice — server/src/invoice/invoice.service.ts). On such a
-- database the CREATE UNIQUE INDEX fails with
--     23505 — Key (order_id)=(...) is duplicated
-- which fails the migration, blocks the whole chain behind it (P3009), and
-- restart-loops the API container. Run this script, then clear the failed
-- _prisma_migrations rows and redeploy — see docs/migration-recovery.md.
--
-- CANCEL, NOT DELETE
-- ------------------
-- Cancelling preserves the audit trail and is exactly what the partial index
-- is designed around: it exempts CANCELLED so the statutory cancel-then-
-- reissue correction flow keeps working. Deleting a filed tax document would
-- not.
--
-- THE OLDEST INVOICE WINS
-- -----------------------
-- These duplicates come from accidental double-issues, so the LATER invoice
-- is the accident. The earlier one is the document most likely already
-- printed, sent to the customer and included in a GSTR filing, and cancelling
-- the higher number leaves the sequence gap at the end rather than mid-run.
-- If a specific order needs the opposite, cancel that one by explicit id
-- BEFORE running this script — it then sees a single live invoice and skips
-- the order entirely.
--
-- REVIEW FIRST — this rewrites statutory records
-- ----------------------------------------------
-- `prisma db execute` discards result rows, so run this diagnostic in a real
-- SQL client (psql against DIRECT_URL, or the DO console) and read the output before
-- executing the script:
--
--   SELECT i.order_id, o.name AS order_name, i.id, i.invoice_number,
--          i.status, i.grand_total, i.financial_year, i.created_at
--   FROM invoices i
--   JOIN orders o ON o.id = i.order_id
--   WHERE i.status <> 'CANCELLED'
--     AND i.order_id IN (
--       SELECT order_id FROM invoices
--       WHERE status <> 'CANCELLED'
--       GROUP BY order_id HAVING COUNT(*) > 1
--     )
--   ORDER BY i.order_id, i.created_at;
--
-- If any of the invoice numbers about to be cancelled were already filed in a
-- past GSTR return, that filing needs an accounting amendment — outside the
-- scope of this script.
--
-- CHECK WHICH DATABASE YOU ARE ON
-- -------------------------------
-- `prisma db execute` does NOT print the "Datasource ..." line that `migrate`
-- commands do, so nothing tells you which database this hit. On 2026-08-03
-- that gap let this script run against production while its operator believed
-- it was pointed at dev — server/.env had been repointed for a deploy — and it
-- cancelled five live invoices with no review. The npm script now chains
-- prisma/scripts/print-target.js ahead of execution so the host is always on
-- screen first. Run it via npm, never `prisma db execute` directly.
--
-- IDEMPOTENT: a second run matches no rows and changes nothing.
--
-- Usage:  npm run db:fix:dedupe-invoices

UPDATE invoices
SET status = 'CANCELLED',
    cancelled_at = NOW(),
    updated_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY order_id
             -- created_at ASC → rn = 1 is the oldest, which survives.
             -- id breaks ties so the result is deterministic when two rows
             -- share a timestamp (same-transaction double-insert).
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM invoices
    WHERE status <> 'CANCELLED'
  ) ranked
  WHERE rn > 1
);

-- Fail loudly rather than let a partial fix look like success: if any order
-- still has more than one live invoice, the migration would fail again on the
-- next deploy with the same 23505.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM (
    SELECT order_id
    FROM invoices
    WHERE status <> 'CANCELLED'
    GROUP BY order_id
    HAVING COUNT(*) > 1
  ) dupes;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'dedupe-active-invoices: % order(s) still have more than one active invoice — the unique index will fail again',
      remaining;
  END IF;

  RAISE NOTICE 'dedupe-active-invoices: OK — every order has at most one active invoice';
END $$;
