-- Campaign automations, part 2 of 3: the engine.
--
-- Hand-written (not `prisma migrate dev`) — see docs/migration-recovery.md.
-- Every statement is guarded so re-running is a no-op. Purely additive.
-- Depends on part 1 (channel_contacts, channel_media).
--
--   automations           What the merchant built. `definition` is the draft
--                         step tree as JSON; the running copy is a version.
--   automation_triggers   What starts it. ONE row per automation in the first
--                         build (enforced in code), several later with no
--                         schema change. This is the table the webhook
--                         matches against, hence the indexes.
--   automation_versions   Immutable snapshot taken on Publish. Runs pin to it
--                         so editing a live automation never disturbs a run
--                         already in flight.
--   automation_events     Ledger of every comment / DM / CRM event that could
--                         start a run. The unique key makes a redelivered
--                         webhook a no-op.
--   automation_runs       One execution of one automation for one event.
--   automation_run_steps  One row per block the run executed.
--
-- Two FKs that point at `messages` (automation_events.message_id,
-- automation_run_steps.message_id) are added in part 3, after that table
-- exists. The columns are created here so the row shape is final.
--
-- Pre-flight: none. Nothing here depends on existing data.

-- ─── enums ───────────────────────────────────────────────────────────────────
-- Only lifecycle statuses are enums. Event types and block types are TEXT and
-- validated by the code registry, so a new channel or block never needs an
-- ALTER TYPE.

DO $$ BEGIN
  CREATE TYPE "AutomationStatus" AS ENUM (
    'DRAFT', 'ACTIVE', 'PAUSED', 'ERROR', 'ARCHIVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AutomationRunStatus" AS ENUM (
    'PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── automations ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "automations" (
    "id"                   TEXT NOT NULL,
    "organization_id"      TEXT NOT NULL,
    -- Channel family from the Create dialog. NULL for CRM-native automations.
    "platform"             "ChannelPlatform",
    -- The specific connected account. NULL for CRM triggers.
    "channel_id"           TEXT,
    -- Creator. The influencer visibility scope, same pattern as
    -- channels.owner_user_id: an influencer sees rows where this is them.
    "owner_user_id"        TEXT,
    "name"                 TEXT NOT NULL,
    "description"          TEXT,
    "status"               "AutomationStatus" NOT NULL DEFAULT 'DRAFT',
    -- { steps: [ { id, type, config, branches? } ] } — the builder's tree.
    "definition"           JSONB NOT NULL,
    "version"              INTEGER NOT NULL DEFAULT 0,
    "published_version_id" TEXT,
    "published_at"         TIMESTAMP(3),
    -- { oncePerContact, maxMessagesPerContactPerDay, maxConsecutiveFailures, ... }
    "settings"             JSONB,
    "triggered_count"      INTEGER NOT NULL DEFAULT 0,
    "last_triggered_at"    TIMESTAMP(3),
    "last_error"           TEXT,
    "last_error_at"        TIMESTAMP(3),
    "archived_at"          TIMESTAMP(3),
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "automations_published_version_id_key"
    ON "automations" ("published_version_id");
CREATE INDEX IF NOT EXISTS "automations_organization_id_status_idx"
    ON "automations" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "automations_organization_id_owner_user_id_idx"
    ON "automations" ("organization_id", "owner_user_id");

DO $$
BEGIN
    ALTER TABLE "automations"
        ADD CONSTRAINT "automations_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SetNull: disconnecting a channel leaves the automation (and its history)
-- in place with no channel; the service shows it as needing reconnection.
DO $$
BEGIN
    ALTER TABLE "automations"
        ADD CONSTRAINT "automations_channel_id_fkey"
        FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automations"
        ADD CONSTRAINT "automations_owner_user_id_fkey"
        FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── automation_triggers ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "automation_triggers" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "automation_id"   TEXT NOT NULL,
    -- Order in the builder once several triggers exist. 0 for now.
    "position"        INTEGER NOT NULL DEFAULT 0,
    -- Which connected account this trigger listens on. NULL for CRM events.
    "channel_id"      TEXT,
    -- "instagram.comment" | "instagram.message" | "whatsapp.message" |
    -- "crm.order.created" | "crm.order.paid" | ... (code registry)
    "trigger_type"    TEXT NOT NULL,
    -- The post: FK for the UI, external id for the webhook (Instagram sends
    -- the media id, not our cuid).
    "media_id"        TEXT,
    "subject_id"      TEXT,
    -- Lower-cased. Empty means "any comment".
    "keywords"        TEXT[] DEFAULT ARRAY[]::TEXT[],
    -- { match: "contains" | "exact" | "any", ... }
    "config"          JSONB,
    -- Mirrors automations.status so the match query never joins.
    "is_active"       BOOLEAN NOT NULL DEFAULT false,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_triggers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "automation_triggers_automation_id_position_key"
    ON "automation_triggers" ("automation_id", "position");

-- The webhook match path: "active triggers on this account, for this event
-- type, on this post". Named explicitly (schema `map:`) because Prisma's
-- generated name would exceed Postgres's 63-character identifier limit.
CREATE INDEX IF NOT EXISTS "automation_triggers_match_idx"
    ON "automation_triggers" ("channel_id", "trigger_type", "subject_id", "is_active");

-- The CRM-event match path (no channel).
CREATE INDEX IF NOT EXISTS "automation_triggers_organization_id_trigger_type_is_active_idx"
    ON "automation_triggers" ("organization_id", "trigger_type", "is_active");

DO $$
BEGIN
    ALTER TABLE "automation_triggers"
        ADD CONSTRAINT "automation_triggers_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_triggers"
        ADD CONSTRAINT "automation_triggers_automation_id_fkey"
        FOREIGN KEY ("automation_id") REFERENCES "automations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_triggers"
        ADD CONSTRAINT "automation_triggers_channel_id_fkey"
        FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_triggers"
        ADD CONSTRAINT "automation_triggers_media_id_fkey"
        FOREIGN KEY ("media_id") REFERENCES "channel_media"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── automation_versions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "automation_versions" (
    "id"                   TEXT NOT NULL,
    "organization_id"      TEXT NOT NULL,
    "automation_id"        TEXT NOT NULL,
    "version"              INTEGER NOT NULL,
    -- Frozen steps, trigger block included. Never updated after insert.
    "definition"           JSONB NOT NULL,
    "settings"             JSONB,
    "published_by_user_id" TEXT,
    "published_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "automation_versions_automation_id_version_key"
    ON "automation_versions" ("automation_id", "version");

DO $$
BEGIN
    ALTER TABLE "automation_versions"
        ADD CONSTRAINT "automation_versions_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_versions"
        ADD CONSTRAINT "automation_versions_automation_id_fkey"
        FOREIGN KEY ("automation_id") REFERENCES "automations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_versions"
        ADD CONSTRAINT "automation_versions_published_by_user_id_fkey"
        FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- automations → automation_versions (the "published" pointer). Added after
-- both tables exist. SetNull so a version can never be deleted from under
-- its automation by accident, only unpublished.
DO $$
BEGIN
    ALTER TABLE "automations"
        ADD CONSTRAINT "automations_published_version_id_fkey"
        FOREIGN KEY ("published_version_id") REFERENCES "automation_versions"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── automation_events ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "automation_events" (
    "id"                TEXT NOT NULL,
    "organization_id"   TEXT NOT NULL,
    -- NULL for CRM events (order paid, customer created).
    "channel_id"        TEXT,
    "event_type"        TEXT NOT NULL,
    -- Comment id / message id / wamid / "<orderId>:paid". THE dedupe key.
    "external_id"       TEXT NOT NULL,
    "occurred_at"       TIMESTAMP(3) NOT NULL,
    "contact_id"        TEXT,
    "customer_id"       TEXT,
    "order_id"          TEXT,
    "media_id"          TEXT,
    -- For DM events: the INBOUND messages row this was raised from, so the
    -- payload is stored once. FK added in part 3.
    "message_id"        TEXT,
    "actor_external_id" TEXT,
    "actor_username"    TEXT,
    -- Comment / message text for keyword matching. Subject to retention.
    "text"              TEXT,
    "payload"           JSONB NOT NULL,
    "processed_at"      TIMESTAMP(3),
    "matched_runs"      INTEGER NOT NULL DEFAULT 0,
    "error"             TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

-- Meta and Shopify both redeliver webhooks. The second delivery of
-- comment_1001 hits this and is dropped; without it a customer gets two DMs.
CREATE UNIQUE INDEX IF NOT EXISTS "automation_events_organization_id_event_type_external_id_key"
    ON "automation_events" ("organization_id", "event_type", "external_id");
CREATE INDEX IF NOT EXISTS "automation_events_organization_id_occurred_at_idx"
    ON "automation_events" ("organization_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "automation_events_contact_id_occurred_at_idx"
    ON "automation_events" ("contact_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "automation_events_channel_id_event_type_occurred_at_idx"
    ON "automation_events" ("channel_id", "event_type", "occurred_at");

-- PARTIAL (not expressible in Prisma; named in the model comment): the
-- worker's "what is still unprocessed" scan stays tiny however large the
-- ledger grows.
CREATE INDEX IF NOT EXISTS "automation_events_unprocessed_idx"
    ON "automation_events" ("organization_id")
    WHERE "processed_at" IS NULL;

DO $$
BEGIN
    ALTER TABLE "automation_events"
        ADD CONSTRAINT "automation_events_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_events"
        ADD CONSTRAINT "automation_events_channel_id_fkey"
        FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_events"
        ADD CONSTRAINT "automation_events_contact_id_fkey"
        FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_events"
        ADD CONSTRAINT "automation_events_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_events"
        ADD CONSTRAINT "automation_events_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_events"
        ADD CONSTRAINT "automation_events_media_id_fkey"
        FOREIGN KEY ("media_id") REFERENCES "channel_media"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── automation_runs ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "automation_runs" (
    "id"                    TEXT NOT NULL,
    "organization_id"       TEXT NOT NULL,
    "automation_id"         TEXT NOT NULL,
    -- The frozen copy this run follows. RESTRICT: a version with runs can
    -- never be deleted out from under them.
    "automation_version_id" TEXT NOT NULL,
    -- Which trigger fired. NULL for test runs.
    "trigger_id"            TEXT,
    -- NULL for test runs and manual runs.
    "event_id"              TEXT,
    "contact_id"            TEXT,
    "customer_id"           TEXT,
    "order_id"              TEXT,
    "status"                "AutomationRunStatus" NOT NULL DEFAULT 'PENDING',
    -- once_per_contact | opted_out | outside_window | daily_cap | ...
    "skip_reason"           TEXT,
    -- Builder "Run test": every block in dry mode, nothing sent.
    "is_test"               BOOLEAN NOT NULL DEFAULT false,
    -- Step id the run executes next.
    "current_step_key"      TEXT,
    -- Wait block: when to wake up.
    "resume_at"             TIMESTAMP(3),
    -- Resolved variables: first_name, product_name, order_number, link, ...
    "context"               JSONB NOT NULL DEFAULT '{}',
    "error"                 TEXT,
    "started_at"            TIMESTAMP(3),
    "completed_at"          TIMESTAMP(3),
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- One run per event per automation. NULL event_id (tests) never collides
-- because NULLs are distinct in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "automation_runs_automation_id_event_id_key"
    ON "automation_runs" ("automation_id", "event_id");
CREATE INDEX IF NOT EXISTS "automation_runs_automation_id_status_idx"
    ON "automation_runs" ("automation_id", "status");
CREATE INDEX IF NOT EXISTS "automation_runs_organization_id_created_at_idx"
    ON "automation_runs" ("organization_id", "created_at");
-- Once-per-contact rule: "has this person been through this automation".
CREATE INDEX IF NOT EXISTS "automation_runs_automation_id_contact_id_idx"
    ON "automation_runs" ("automation_id", "contact_id");

-- PARTIAL (named in the model comment): the scheduler's wake-up scan reads
-- only sleeping runs, ordered by when they are due.
CREATE INDEX IF NOT EXISTS "automation_runs_waiting_resume_idx"
    ON "automation_runs" ("resume_at")
    WHERE "status" = 'WAITING';

DO $$
BEGIN
    ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_automation_id_fkey"
        FOREIGN KEY ("automation_id") REFERENCES "automations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_automation_version_id_fkey"
        FOREIGN KEY ("automation_version_id") REFERENCES "automation_versions"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_trigger_id_fkey"
        FOREIGN KEY ("trigger_id") REFERENCES "automation_triggers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "automation_events"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_contact_id_fkey"
        FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_runs"
        ADD CONSTRAINT "automation_runs_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── automation_run_steps ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "automation_run_steps" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "run_id"          TEXT NOT NULL,
    -- Denormalised so per-block stats group without joining runs.
    "automation_id"   TEXT NOT NULL,
    -- The step id from the definition. Stable across versions.
    "step_key"        TEXT NOT NULL,
    "block_type"      TEXT NOT NULL,
    "attempt"         INTEGER NOT NULL DEFAULT 1,
    "status"          "AutomationRunStatus" NOT NULL,
    "input"           JSONB,
    -- Block result: message id for sends, wake time for wait, branch later.
    "output"          JSONB,
    -- The message a send step created. FK added in part 3.
    "message_id"      TEXT,
    "error"           TEXT,
    "started_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at"     TIMESTAMP(3),

    CONSTRAINT "automation_run_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "automation_run_steps_run_id_step_key_attempt_key"
    ON "automation_run_steps" ("run_id", "step_key", "attempt");
CREATE INDEX IF NOT EXISTS "automation_run_steps_automation_id_step_key_status_idx"
    ON "automation_run_steps" ("automation_id", "step_key", "status");

DO $$
BEGIN
    ALTER TABLE "automation_run_steps"
        ADD CONSTRAINT "automation_run_steps_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_run_steps"
        ADD CONSTRAINT "automation_run_steps_run_id_fkey"
        FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_run_steps"
        ADD CONSTRAINT "automation_run_steps_automation_id_fkey"
        FOREIGN KEY ("automation_id") REFERENCES "automations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
