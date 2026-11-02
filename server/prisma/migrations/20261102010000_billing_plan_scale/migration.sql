-- A plan between Growth and Enterprise: Unlimited, stored as SCALE. Existing
-- rows keep their plan; BASIC now shows as Starter. See src/billing/pricing.ts.
--
-- Safe inside a transaction on PostgreSQL 12+ because nothing in this
-- migration uses the new value.
ALTER TYPE "BillingPlan" ADD VALUE IF NOT EXISTS 'SCALE' BEFORE 'ADVANCE';
