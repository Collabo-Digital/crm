-- One external account (a WhatsApp Business account, a Facebook Page, an
-- Instagram account, a Shopify shop) may be claimed by one channel row only,
-- across every organization.
--
-- Meta signs webhooks with the app's secret, which names no tenant, so the
-- account id in the payload (external_store_id) is what picks the workspace.
-- The schema and migrations 20260731140000 and 20260910090000 describe this
-- index as already there, but no migration created it, so a database built
-- from the migrations lacks it. Disconnect nulls external_store_id, and
-- Postgres treats NULLs as distinct, so disconnected rows never collide.
--
-- Guarded so that a deploy cannot fail on a database that already holds
-- duplicates: the index is then NOT created and a NOTICE says so. The
-- application still refuses a second organization's claim and routes
-- webhooks to one row deterministically; only a race between two connects is
-- left open until the index exists. Prisma does not record that the index
-- was skipped, so check after deploying:
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'channels' AND indexname = 'channels_platform_external_store_id_key';
--
-- If it is missing, resolve the duplicates and create it by hand:
--
--   1. List them. Webhooks now go to the CONNECTED row connected first.
--
--        SELECT platform, external_store_id,
--               array_agg(id || ' org=' || organization_id || ' ' || status || ' since ' ||
--                         coalesce(connected_at::text, '?') ORDER BY connected_at) AS claims
--          FROM channels
--         WHERE external_store_id IS NOT NULL
--         GROUP BY platform, external_store_id
--        HAVING count(*) > 1;
--
--   2. Keep the row that really owns each account and release the others'
--      claims in SQL. Not with Disconnect in the app: that also unsubscribes
--      Collabo's app from the account at Meta, which would stop the webhooks
--      of the row being kept.
--
--        UPDATE channels
--           SET status = 'DISCONNECTED', credentials = NULL,
--               external_store_id = NULL, external_store_url = NULL,
--               metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
--                 'externalAccountId', external_store_id, 'disconnectedAt', now())
--         WHERE id IN ('<row id>', ...);
--
--   3. Build the index without blocking writes:
--
--        CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "channels_platform_external_store_id_key"
--          ON "channels" ("platform", "external_store_id");

DO $$
DECLARE
  claimed_twice integer;
BEGIN
  SELECT count(*) INTO claimed_twice
    FROM (
      SELECT 1
        FROM "channels"
       WHERE "external_store_id" IS NOT NULL
       GROUP BY "platform", "external_store_id"
      HAVING count(*) > 1
    ) AS duplicates;

  IF claimed_twice > 0 THEN
    RAISE NOTICE 'channels_platform_external_store_id_key not created: % account(s) are claimed by more than one channel. See migration 20261031010000_channel_external_account_unique.', claimed_twice;
    RETURN;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS "channels_platform_external_store_id_key"
    ON "channels" ("platform", "external_store_id");
EXCEPTION
  -- A duplicate written between the count and the build.
  WHEN unique_violation THEN
    RAISE NOTICE 'channels_platform_external_store_id_key not created: an account was claimed twice while it was built. See migration 20261031010000_channel_external_account_unique.';
END $$;
