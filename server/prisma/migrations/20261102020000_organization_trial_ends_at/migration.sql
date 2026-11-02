-- When a workspace's free trial ends, and when its subscription's payment
-- first failed (halted or paused). Nullable and not backfilled: while
-- BILLING_ENFORCEMENT is off nothing reads them, and once it is on a
-- workspace without a trial end gets a trial ending BILLING_TRIAL_DAYS after
-- BILLING_ENFORCE_FROM.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "trial_ends_at" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payment_failed_at" TIMESTAMP(3);
