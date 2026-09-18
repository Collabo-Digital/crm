-- Campaign automations, part 3 of 3: chat history.
--
-- Hand-written (not `prisma migrate dev`) — see docs/migration-recovery.md.
-- Every statement is guarded so re-running is a no-op. Depends on parts 1
-- and 2.
--
--   conversations  One thread per (channel, contact). The inbox reads only
--                  this table; its cached columns are kept current by the
--                  message writers.
--   messages       Every message in BOTH directions on any channel. Replaces
--                  whatsapp_message_logs, which was outbound-only, WhatsApp-
--                  only, and had nowhere to put a run, a step, an inbound DM
--                  or an invoice attachment.
--
-- ⚠️ THIS FILE TOUCHES EXISTING DATA (read-only on the old table): every
-- whatsapp_message_logs row is copied into messages KEEPING ITS ID, so the
-- copy is idempotent and later reconciliation is a join on id. The old table
-- is left exactly as it was. WhatsAppMessagingService keeps writing to it
-- until it is switched to `messages` in code; a later migration drops it
-- once `SELECT count(*) FROM whatsapp_message_logs w WHERE NOT EXISTS
-- (SELECT 1 FROM messages m WHERE m.id = w.id)` is zero.
--
-- Pre-flight, run against the target BEFORE applying:
--
--   -- (a) every status must be one of the five the enum accepts:
--   SELECT DISTINCT status FROM whatsapp_message_logs;
--   -- expected ⊆ {queued, sent, delivered, read, failed}
--
--   -- (b) must return zero rows, or the partial unique on
--   --     (channel_id, external_id) cannot be created:
--   SELECT channel_id, external_id, count(*)
--     FROM whatsapp_message_logs
--    WHERE external_id IS NOT NULL
--    GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Both checks are ALSO enforced below with RAISE EXCEPTION, so a bad state
-- fails the migration loudly instead of half-applying.

-- ─── enums ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "MessageKind" AS ENUM (
    'TEXT', 'TEMPLATE', 'DOCUMENT', 'IMAGE', 'PRIVATE_REPLY'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MessageStatus" AS ENUM (
    'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED', 'SNOOZED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── pre-flight enforced ─────────────────────────────────────────────────────

DO $$
DECLARE
    bad_status TEXT;
    dup_count  INTEGER;
BEGIN
    SELECT string_agg(DISTINCT status, ', ') INTO bad_status
      FROM "whatsapp_message_logs"
     WHERE status NOT IN ('queued', 'sent', 'delivered', 'read', 'failed');
    IF bad_status IS NOT NULL THEN
        RAISE EXCEPTION
            'whatsapp_message_logs has status values the MessageStatus enum cannot hold: %. Fix them before applying 20260918090200_campaign_messages.',
            bad_status;
    END IF;

    SELECT count(*) INTO dup_count
      FROM (SELECT channel_id, external_id
              FROM "whatsapp_message_logs"
             WHERE external_id IS NOT NULL
             GROUP BY 1, 2 HAVING count(*) > 1) d;
    IF dup_count > 0 THEN
        RAISE EXCEPTION
            'whatsapp_message_logs has % (channel_id, external_id) duplicates; messages_channel_external_id_key cannot be created. Resolve them first.',
            dup_count;
    END IF;
END $$;

-- ─── conversations ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "conversations" (
    "id"                   TEXT NOT NULL,
    "organization_id"      TEXT NOT NULL,
    "channel_id"           TEXT NOT NULL,
    "contact_id"           TEXT NOT NULL,
    -- Copied from the channel so the inbox filters by network without a join.
    "platform"             "ChannelPlatform" NOT NULL,
    "customer_id"          TEXT,
    "status"               "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "last_message_at"      TIMESTAMP(3),
    "last_inbound_at"      TIMESTAMP(3),
    "last_outbound_at"     TIMESTAMP(3),
    -- First ~140 chars of the latest message. Inbox subtitle, no join.
    "last_message_preview" TEXT,
    -- Inbound rows staff have not opened yet.
    "unread_count"         INTEGER NOT NULL DEFAULT 0,
    "message_count"        INTEGER NOT NULL DEFAULT 0,
    -- For the future Chat module; unused by automations.
    "assigned_user_id"     TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- One thread per person per connected account; the writers UPSERT on it.
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_channel_id_contact_id_key"
    ON "conversations" ("channel_id", "contact_id");
-- The inbox query: this org, open threads, newest first.
CREATE INDEX IF NOT EXISTS "conversations_organization_id_status_last_message_at_idx"
    ON "conversations" ("organization_id", "status", "last_message_at");
CREATE INDEX IF NOT EXISTS "conversations_customer_id_idx"
    ON "conversations" ("customer_id");

DO $$
BEGIN
    ALTER TABLE "conversations"
        ADD CONSTRAINT "conversations_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "conversations"
        ADD CONSTRAINT "conversations_channel_id_fkey"
        FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "conversations"
        ADD CONSTRAINT "conversations_contact_id_fkey"
        FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "conversations"
        ADD CONSTRAINT "conversations_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "conversations"
        ADD CONSTRAINT "conversations_assigned_user_id_fkey"
        FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── messages ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "messages" (
    "id"                      TEXT NOT NULL,
    "organization_id"         TEXT NOT NULL,
    "channel_id"              TEXT NOT NULL,
    "platform"                "ChannelPlatform" NOT NULL,
    "direction"               "MessageDirection" NOT NULL DEFAULT 'OUTBOUND',
    "kind"                    "MessageKind" NOT NULL,
    "conversation_id"         TEXT,
    "contact_id"              TEXT,
    "customer_id"             TEXT,
    "order_id"                TEXT,
    -- Set by the "Send invoice" block; the PDF is attached from the invoice.
    "invoice_id"              TEXT,
    -- Outbound: recipient (E.164 / IGSID / comment id).
    -- Inbound:  our own account id.
    "to_address"              TEXT NOT NULL,
    -- Outbound: our account id. Inbound: the contact's E.164 / IGSID.
    "from_address"            TEXT,
    -- Plain text for the chat view and previews.
    "text"                    TEXT,
    "template_name"           TEXT,
    "template_language"       TEXT,
    -- Instagram comment id this private reply answers.
    "in_reply_to_external_id" TEXT,
    -- Outbound: exactly what was sent. Inbound: the webhook message object.
    "body"                    JSONB NOT NULL,
    "response_payload"        JSONB,
    "status"                  "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    -- wamid.* or Instagram message id.
    "external_id"             TEXT,
    "error_code"              TEXT,
    "error_message"           TEXT,
    "sent_at"                 TIMESTAMP(3),
    "delivered_at"            TIMESTAMP(3),
    "read_at"                 TIMESTAMP(3),
    "failed_at"               TIMESTAMP(3),
    -- Provenance. NULL for inbound rows and for staff replies.
    "automation_id"           TEXT,
    "automation_run_id"       TEXT,
    "step_key"                TEXT,
    -- Legacy label carried over from the old log ("order_placed", "manual").
    "trigger_type"            TEXT,
    -- "run:<runId>:<stepKey>:<attempt>" — send-once on retry.
    "idempotency_key"         TEXT,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "messages_idempotency_key_key"
    ON "messages" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "messages_organization_id_status_created_at_idx"
    ON "messages" ("organization_id", "status", "created_at");
-- The thread view.
CREATE INDEX IF NOT EXISTS "messages_conversation_id_created_at_idx"
    ON "messages" ("conversation_id", "created_at");
CREATE INDEX IF NOT EXISTS "messages_contact_id_created_at_idx"
    ON "messages" ("contact_id", "created_at");
CREATE INDEX IF NOT EXISTS "messages_automation_id_created_at_idx"
    ON "messages" ("automation_id", "created_at");
CREATE INDEX IF NOT EXISTS "messages_automation_run_id_idx"
    ON "messages" ("automation_run_id");
CREATE INDEX IF NOT EXISTS "messages_order_id_idx"
    ON "messages" ("order_id");

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_channel_id_fkey"
        FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_conversation_id_fkey"
        FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_contact_id_fkey"
        FOREIGN KEY ("contact_id") REFERENCES "channel_contacts"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_order_id_fkey"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_invoice_id_fkey"
        FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_automation_id_fkey"
        FOREIGN KEY ("automation_id") REFERENCES "automations"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "messages"
        ADD CONSTRAINT "messages_automation_run_id_fkey"
        FOREIGN KEY ("automation_run_id") REFERENCES "automation_runs"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── the two FKs deferred from part 2 ────────────────────────────────────────

DO $$
BEGIN
    ALTER TABLE "automation_run_steps"
        ADD CONSTRAINT "automation_run_steps_message_id_fkey"
        FOREIGN KEY ("message_id") REFERENCES "messages"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "automation_events"
        ADD CONSTRAINT "automation_events_message_id_fkey"
        FOREIGN KEY ("message_id") REFERENCES "messages"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── backfill from whatsapp_message_logs ─────────────────────────────────────
--
-- Same ids, so re-running copies nothing. Every old row was an outbound
-- WhatsApp template send; nothing else was ever written there.
-- conversation_id stays NULL: there is no contact row for these people yet.
-- The contact backfill happens in code once WhatsApp inbound webhooks exist.

INSERT INTO "messages" (
    "id", "organization_id", "channel_id", "platform", "direction", "kind",
    "customer_id", "order_id",
    "to_address", "template_name", "template_language",
    "body", "response_payload", "status", "external_id",
    "error_code", "error_message",
    "sent_at", "delivered_at", "read_at", "failed_at",
    "trigger_type",
    "created_at", "updated_at"
)
SELECT
    w."id", w."organization_id", w."channel_id",
    'WHATSAPP'::"ChannelPlatform", 'OUTBOUND'::"MessageDirection", 'TEMPLATE'::"MessageKind",
    w."customer_id", w."order_id",
    w."to_phone", w."template_name", w."template_language",
    w."request_payload", w."response_payload",
    upper(w."status")::"MessageStatus", w."external_id",
    w."error_code", w."error_message",
    w."sent_at", w."delivered_at", w."read_at", w."failed_at",
    w."trigger_type",
    w."created_at",
    COALESCE(w."failed_at", w."read_at", w."delivered_at", w."sent_at", w."created_at")
FROM "whatsapp_message_logs" w
WHERE NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = w."id");

-- ─── partial uniques (not expressible in Prisma; named in the model comment) ─
-- Created AFTER the backfill so the pre-flight duplicate check above is what
-- decides, with its readable message, rather than a raw index error here.

-- Inbound dedupe: the same DM webhook delivered twice is stored once. Also the
-- lookup key for delivery/read status webhooks on outbound rows.
CREATE UNIQUE INDEX IF NOT EXISTS "messages_channel_external_id_key"
    ON "messages" ("channel_id", "external_id")
    WHERE "external_id" IS NOT NULL;

-- Meta allows exactly one private reply per comment. A retry that lost the
-- first response cannot send a second.
CREATE UNIQUE INDEX IF NOT EXISTS "messages_one_private_reply_per_comment_key"
    ON "messages" ("channel_id", "in_reply_to_external_id")
    WHERE "kind" = 'PRIVATE_REPLY';
