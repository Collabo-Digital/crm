-- Hot-path indexes from the launch audit: partial, expression and trigram
-- indexes, which Prisma's schema cannot declare.

-- Automation sweeps: runs waiting to start, and running ones that may have stalled.
CREATE INDEX IF NOT EXISTS "automation_runs_pending_created_idx" ON "automation_runs" ("created_at") WHERE "status" = 'PENDING';
CREATE INDEX IF NOT EXISTS "automation_runs_running_updated_idx" ON "automation_runs" ("updated_at") WHERE "status" = 'RUNNING';

-- Matching a WhatsApp number to a store customer by its last ten digits
-- (storedPhoneIs in contact-identity.service.ts uses this exact expression).
CREATE INDEX IF NOT EXISTS "customers_org_phone_last10_idx" ON "customers" ("organization_id", right(regexp_replace("phone", '\D', '', 'g'), 10)) WHERE "phone" IS NOT NULL;

-- Inbox search: case-insensitive "contains" over message text.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "messages_text_trgm_idx" ON "messages" USING gin ("text" gin_trgm_ops);
