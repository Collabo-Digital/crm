-- When a workspace's free trial ends. Nullable and not backfilled: while
-- BILLING_ENFORCEMENT is off nothing reads it, and once it is on a workspace
-- without one gets a trial ending BILLING_TRIAL_DAYS after BILLING_ENFORCE_FROM.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "trial_ends_at" TIMESTAMP(3);
