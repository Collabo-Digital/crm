-- A webhook trigger's token belongs to one automation only.
--
-- POST /automations/hooks/:token finds its automation by
-- automation_triggers.subject_id alone, across every organization, so two
-- rows holding the same token would let row order pick the tenant. Tokens are
-- issued only by the server on publish (18 random bytes); this index turns a
-- duplicate into a failed publish instead of a call routed to the wrong
-- organization.
--
-- Partial because subject_id holds other things for other trigger types (the
-- post a comment trigger listens on), which many automations may share.
--
-- Pre-flight: expected to return zero rows. Re-check before deploying with:
--
--   SELECT subject_id, COUNT(*), array_agg(automation_id)
--   FROM automation_triggers
--   WHERE trigger_type = 'crm.webhook' AND subject_id IS NOT NULL
--   GROUP BY subject_id
--   HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "automation_triggers_webhook_token_key"
  ON "automation_triggers"("subject_id")
  WHERE "trigger_type" = 'crm.webhook';
