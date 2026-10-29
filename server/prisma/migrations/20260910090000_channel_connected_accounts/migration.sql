-- One Channel row = one CONNECTED ACCOUNT.
--
-- Until now `(organization_id, platform)` was a plain unique, so an org could
-- hold at most one channel per platform. That is right for Shopify, right for
-- MANUAL, and right for WhatsApp (Meta issues one WABA per business), but wrong
-- for Instagram: a merchant legitimately runs several Instagram accounts and
-- must be able to connect all of them.
--
-- The uniqueness that remains is expressed as a PARTIAL index, which Prisma
-- cannot model — hence hand-written SQL, in the style of
-- 20260729130000_one_active_invoice_per_order.
--
-- Two guarantees are deliberately UNCHANGED and still carry the "same account
-- cannot be connected twice" rule across the whole system:
--   channels_platform_external_store_id_key   UNIQUE (platform, external_store_id)
--   channels_platform_external_store_url_key  UNIQUE (platform, external_store_url)
--                                             WHERE external_store_url IS NOT NULL
-- The first is what stops one Instagram account being connected to two orgs —
-- or twice to the same org — because external_store_id holds the Instagram
-- business account id. Disconnect nulls that column to release the claim and
-- copies the id into metadata.externalAccountId so the row can be revived.
--
-- Hand-written (not `prisma migrate dev`) because this schema carries known
-- drift; every statement is guarded so it is safe to re-run.
--
-- Pre-flight, run against the target BEFORE applying. Must return zero rows —
-- if it does not, two rows would collide under the new partial unique:
--
--   SELECT organization_id, platform, count(*)
--   FROM channels
--   WHERE platform = 'MANUAL'
--      OR (platform = 'WHATSAPP' AND status <> 'DISCONNECTED')
--   GROUP BY 1, 2
--   HAVING count(*) > 1;
--
-- Verified on the dev DB (aws-1-ap-south-1) 2026-09-08: zero rows.

-- 1. Drop the blanket unique. Its presence varies by environment: migration
--    20260330050718_add_channels created it, but the schema comment recorded it
--    as lost in the drift, so IF EXISTS covers both states.
DROP INDEX IF EXISTS "channels_organization_id_platform_key";

-- 2. Keep the lookup path — (organization_id, platform) is the hot filter for
--    every "find this org's Shopify/WhatsApp channel" query.
CREATE INDEX IF NOT EXISTS "channels_organization_id_platform_idx"
  ON "channels" ("organization_id", "platform");

-- 3. One ACTIVE account per org for the single-account platforms.
--
--    The status predicate is what lets history survive: a DISCONNECTED WhatsApp
--    row stays in the table (its whatsapp_message_logs still point at it, and
--    those must keep naming the WABA that actually sent them) without occupying
--    the org's slot. Reconnecting the same WABA revives that row; connecting a
--    different one creates a new row beside it.
--
--    MANUAL has no disconnect path and findAllForOrg auto-heals it to
--    CONNECTED, so for it the predicate is effectively unconditional — which is
--    what the five lazy `upsert` call sites relied on the old unique for, and
--    what ensureManualChannel() now relies on to make its P2002 retry correct.
--
--    INSTAGRAM is deliberately absent: many accounts per org is the point.
CREATE UNIQUE INDEX IF NOT EXISTS "channels_one_active_per_org_platform_key"
  ON "channels" ("organization_id", "platform")
  WHERE "platform" = 'MANUAL'
     OR ("platform" = 'WHATSAPP' AND "status" <> 'DISCONNECTED');

-- 4. When the account was connected, and why it is unhealthy.
--    created_at is not the answer to "connected date": a row that was
--    disconnected and reconnected keeps its original created_at.
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "connected_at" TIMESTAMP(3);
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "last_error" TEXT;

-- 5. Backfill. WhatsApp rows already carry credentials.connectedAt (written by
--    WhatsAppOAuthService); everything else has been connected since creation.
--    Disconnected rows keep a NULL connected date — they have no live account.
UPDATE "channels"
   SET "connected_at" = COALESCE(
         NULLIF("credentials" ->> 'connectedAt', '')::timestamptz,
         "created_at")
 WHERE "connected_at" IS NULL
   AND "status" <> 'DISCONNECTED';
