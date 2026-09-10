-- Influencer invitations and the Organization -> Influencer -> Instagram link.
--
-- Three things:
--   1. INFLUENCER joins the UserRole enum.
--   2. team_invites gains the fields an invitation lifecycle needs (a name to
--      address the person by, who accepted, when it was cancelled) plus a
--      partial unique index so one address cannot hold two LIVE invites to the
--      same organization.
--   3. channels gains owner_user_id: which member personally connected this
--      account. That single column is the whole influencer -> Instagram
--      relationship; an influencer sees only rows where it is them.
--
-- IMPORTANT — this migration is written to be re-runnable, and on the dev
-- database most of it is already a no-op. A migration recorded as
-- `20260713000000_channel_connect_influencer` was applied there on 2026-07-15
-- but was never committed to this repository (only a row in _prisma_migrations
-- remains). It had already added the INFLUENCER enum value, channels.owner_user_id
-- and channels.token_expires_at, none of which appear in schema.prisma and none
-- of which any code referenced. Production has NOT had that migration, so every
-- statement here is guarded to work against both.
--
-- Pre-flight, run against the target before applying. All three must be safe:
--
--   -- (a) does the enum value already exist?
--   SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
--    WHERE t.typname = 'UserRole' ORDER BY e.enumsortorder;
--
--   -- (b) must return zero rows, or the partial unique below cannot be created:
--   SELECT organization_id, lower(email), count(*)
--     FROM team_invites WHERE status = 'PENDING'
--    GROUP BY 1, 2 HAVING count(*) > 1;
--
--   -- (c) addresses that would change under normalisation, for awareness:
--   SELECT id, email FROM team_invites WHERE email <> lower(btrim(email));
--
-- Verified on dev (aws-1-ap-south-1) 2026-09-08: enum value already present,
-- zero duplicate pending invites, zero non-normalised addresses.

-- 1. The role.
--
-- Safe inside a transaction on PostgreSQL 12+ *because no other statement in
-- this migration references the new value* — a value added in a transaction
-- cannot be used by that same transaction. Supabase runs PG 15. Same shape as
-- 20260626130000_add_vendor_role, which added VENDOR.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'INFLUENCER';

-- 2. Invitation lifecycle fields.
ALTER TABLE "team_invites" ADD COLUMN IF NOT EXISTS "name" TEXT;
ALTER TABLE "team_invites" ADD COLUMN IF NOT EXISTS "accepted_user_id" TEXT;
ALTER TABLE "team_invites" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMP(3);

-- Normalise existing addresses so the unique index below means what it says.
-- Acceptance compares on the stored value, so this also makes historical
-- invites claimable regardless of the casing they were typed in.
UPDATE "team_invites"
   SET "email" = lower(btrim("email"))
 WHERE "email" <> lower(btrim("email"));

-- Backfill the cancellation date for invites revoked before the column existed.
-- updated_at is when the revoke happened for those rows, since REVOKED is
-- terminal and nothing touches them afterwards.
UPDATE "team_invites"
   SET "revoked_at" = "updated_at"
 WHERE "status" = 'REVOKED' AND "revoked_at" IS NULL;

-- One LIVE invite per organization and address.
--
-- Partial, because the same address legitimately accumulates history: an invite
-- that was accepted, one that expired, one that was cancelled and re-sent. Only
-- PENDING may be unique, or re-inviting anyone would be impossible.
CREATE UNIQUE INDEX IF NOT EXISTS "team_invites_one_pending_per_org_email_key"
  ON "team_invites" ("organization_id", "email")
  WHERE "status" = 'PENDING';

-- 3. Who connected a channel.
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "owner_user_id" TEXT;

-- Deliberately SetNull, not Cascade: removing a person must not take their
-- connected channel — and the orders and message logs that reference it — with
-- them. The row survives as an org-level channel with no owner.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_owner_user_id_fkey'
  ) THEN
    ALTER TABLE "channels"
      ADD CONSTRAINT "channels_owner_user_id_fkey"
      FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "channels_organization_id_owner_user_id_idx"
  ON "channels" ("organization_id", "owner_user_id");
