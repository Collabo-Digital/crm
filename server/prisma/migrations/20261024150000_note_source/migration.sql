-- Notes written by an automation or an inbox rule say so, instead of looking like
-- a deleted member's.
ALTER TABLE "conversation_notes" ADD COLUMN "source" TEXT;
