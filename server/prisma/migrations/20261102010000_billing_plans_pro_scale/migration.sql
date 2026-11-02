-- Two plans between Growth and Enterprise: Pro (self-serve) and Scale (sold
-- after a demo and invoiced by the Collabo team). Existing rows keep their
-- plan; BASIC now shows as Starter. See src/billing/pricing.ts.
--
-- Safe inside a transaction on PostgreSQL 12+ because nothing in this
-- migration uses the new values.
ALTER TYPE "BillingPlan" ADD VALUE IF NOT EXISTS 'PRO' BEFORE 'ADVANCE';
ALTER TYPE "BillingPlan" ADD VALUE IF NOT EXISTS 'SCALE' BEFORE 'ADVANCE';
