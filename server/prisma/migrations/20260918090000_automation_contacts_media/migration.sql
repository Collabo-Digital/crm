-- Campaign automations, part 1 of 3: the people and posts the engine refers to.
--
-- Hand-written (not `prisma migrate dev`) — see docs/migration-recovery.md.
-- Every statement is guarded so re-running is a no-op. Purely additive: no
-- existing table or row is touched.
--
-- Three tables:
--   channel_contacts     A person on ONE connected account: an Instagram user
--                        (IGSID) or a WhatsApp number. Deliberately NOT a
--                        customer — a commenter has no email and no order.
--                        Carries the two Meta window timestamps (24h since
--                        their last DM, 7 days since their last comment) and
--                        the anti-spam counters the send gate reads.
--   channel_media        Cached posts/reels of an Instagram account: the
--                        trigger's post picker and the trigger subject.
--   contact_daily_stats  Per-contact per-day send counters for daily caps.
--
-- Pre-flight: none. Nothing here depends on existing data.

-- ─── channel_contacts ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "channel_contacts" (
    "id"                      TEXT NOT NULL,
    "organization_id"         TEXT NOT NULL,
    "channel_id"              TEXT NOT NULL,
    "platform"                "ChannelPlatform" NOT NULL,
    -- IGSID for Instagram, wa_id (E.164 digits) for WhatsApp.
    "external_id"             TEXT NOT NULL,
    "username"                TEXT,
    "display_name"            TEXT,
    "profile_pic_url"         TEXT,
    "phone"                   TEXT,
    "customer_id"             TEXT,
    -- Opens the 24-hour DM window.
    "last_inbound_message_at" TIMESTAMP(3),
    -- Opens the 7-day private-reply window.
    "last_comment_at"         TIMESTAMP(3),
    "last_outbound_at"        TIMESTAMP(3),
    "opted_out_at"            TIMESTAMP(3),
    "opt_out_source"          TEXT,
    -- Anti-spam counters. Caches, updated in the same transaction as the
    -- messages row; `messages` is the truth if they ever drift.
    "outbound_count"          INTEGER NOT NULL DEFAULT 0,
    "outbound_sent_count"     INTEGER NOT NULL DEFAULT 0,
    "outbound_failed_count"   INTEGER NOT NULL DEFAULT 0,
    "inbound_count"           INTEGER NOT NULL DEFAULT 0,
    "consecutive_failures"    INTEGER NOT NULL DEFAULT 0,
    "muted_until"             TIMESTAMP(3),
    "metadata"                JSONB,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_contacts_pkey" PRIMARY KEY ("id")
);

-- One row per person per connected account. The same human on two Instagram
-- accounts is two rows, because Meta issues a different IGSID per account.
CREATE UNIQUE INDEX IF NOT EXISTS "channel_contacts_channel_id_external_id_key"
    ON "channel_contacts" ("channel_id", "external_id");
CREATE INDEX IF NOT EXISTS "channel_contacts_organization_id_platform_idx"
    ON "channel_contacts" ("organization_id", "platform");
CREATE INDEX IF NOT EXISTS "channel_contacts_customer_id_idx"
    ON "channel_contacts" ("customer_id");
CREATE INDEX IF NOT EXISTS "channel_contacts_organization_id_phone_idx"
    ON "channel_contacts" ("organization_id", "phone");

DO $$
BEGIN
    ALTER TABLE "channel_contacts"
        ADD CONSTRAINT "channel_contacts_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "channel_contacts"
        ADD CONSTRAINT "channel_contacts_channel_id_fkey"
        FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SetNull: deleting a customer must not delete the person's chat identity.
DO $$
BEGIN
    ALTER TABLE "channel_contacts"
        ADD CONSTRAINT "channel_contacts_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── channel_media ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "channel_media" (
    "id"                  TEXT NOT NULL,
    "organization_id"     TEXT NOT NULL,
    "channel_id"          TEXT NOT NULL,
    -- Instagram media id — what the comment webhook carries.
    "external_id"         TEXT NOT NULL,
    -- IMAGE | VIDEO | CAROUSEL_ALBUM | REEL. Text, not enum: Meta adds kinds.
    "media_type"          TEXT NOT NULL,
    "permalink"           TEXT,
    "thumbnail_url"       TEXT,
    "caption"             TEXT,
    "posted_at"           TIMESTAMP(3),
    "like_count"          INTEGER NOT NULL DEFAULT 0,
    "comment_count"       INTEGER NOT NULL DEFAULT 0,
    "insights"            JSONB,
    "insights_fetched_at" TIMESTAMP(3),
    -- Set when Instagram no longer returns the post; the row is kept so old
    -- automations and runs still resolve their subject.
    "deleted_at"          TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "channel_media_channel_id_external_id_key"
    ON "channel_media" ("channel_id", "external_id");
CREATE INDEX IF NOT EXISTS "channel_media_organization_id_posted_at_idx"
    ON "channel_media" ("organization_id", "posted_at");
CREATE INDEX IF NOT EXISTS "channel_media_channel_id_posted_at_idx"
    ON "channel_media" ("channel_id", "posted_at");

DO $$
BEGIN
    ALTER TABLE "channel_media"
        ADD CONSTRAINT "channel_media_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "channel_media"
        ADD CONSTRAINT "channel_media_channel_id_fkey"
        FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── contact_daily_stats ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "contact_daily_stats" (
    "id"                   TEXT NOT NULL,
    "organization_id"      TEXT NOT NULL,
    "contact_id"           TEXT NOT NULL,
    "date"                 DATE NOT NULL,
    "sent_count"           INTEGER NOT NULL DEFAULT 0,
    "delivered_count"      INTEGER NOT NULL DEFAULT 0,
    "failed_count"         INTEGER NOT NULL DEFAULT 0,
    "inbound_count"        INTEGER NOT NULL DEFAULT 0,
    "automation_run_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "contact_daily_stats_pkey" PRIMARY KEY ("id")
);

-- One row per contact per calendar day; the writers UPSERT on this pair.
CREATE UNIQUE INDEX IF NOT EXISTS "contact_daily_stats_contact_id_date_key"
    ON "contact_daily_stats" ("contact_id", "date");
CREATE INDEX IF NOT EXISTS "contact_daily_stats_organization_id_date_idx"
    ON "contact_daily_stats" ("organization_id", "date");

DO $$
BEGIN
    ALTER TABLE "contact_daily_stats"
        ADD CONSTRAINT "contact_daily_stats_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "contact_daily_stats"
        ADD CONSTRAINT "contact_daily_stats_contact_id_fkey"
        FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
