-- Invoices, GST returns and payment fees now need `reports.finance` on top of
-- the Invoices section (see src/auth/permissions.ts). Hand it to every Agent
-- and Viewer who reads them today, so nobody loses them on deploy: those who
-- hold the Invoices section, and those who hold no section at all (they
-- joined before section access existed and open everything).
--
-- Pending invitations get it on the same terms: their grants are copied onto
-- the membership when accepted.
--
-- A grant list that is not a JSON array reads as empty in extractGrants, so it
-- is replaced here by one holding only the new key. Safe to re-apply: a member
-- or invitation that already holds the key is left alone.

UPDATE "organization_members" AS m
SET "permissions" = jsonb_set(
      CASE WHEN jsonb_typeof(m."permissions") = 'object' THEN m."permissions" ELSE '{}'::jsonb END,
      '{grants}',
      g.grants || '["reports.finance"]'::jsonb
    )
FROM (
  SELECT "id",
         CASE WHEN jsonb_typeof("permissions"->'grants') = 'array' THEN "permissions"->'grants' ELSE '[]'::jsonb END AS grants
  FROM "organization_members"
) AS g
WHERE g."id" = m."id"
  AND m."role" IN ('AGENT', 'VIEWER')
  AND m."is_active" = true
  AND NOT g.grants ? 'reports.finance'
  AND (
    g.grants ? 'section.invoices'
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(g.grants) AS k
      WHERE jsonb_typeof(k) = 'string' AND (k #>> '{}') LIKE 'section.%'
    )
  );

UPDATE "team_invites" AS i
SET "permissions" = jsonb_set(
      CASE WHEN jsonb_typeof(i."permissions") = 'object' THEN i."permissions" ELSE '{}'::jsonb END,
      '{grants}',
      g.grants || '["reports.finance"]'::jsonb
    )
FROM (
  SELECT "id",
         CASE WHEN jsonb_typeof("permissions"->'grants') = 'array' THEN "permissions"->'grants' ELSE '[]'::jsonb END AS grants
  FROM "team_invites"
) AS g
WHERE g."id" = i."id"
  AND i."role" IN ('AGENT', 'VIEWER')
  AND i."status" = 'PENDING'
  AND NOT g.grants ? 'reports.finance'
  AND (
    g.grants ? 'section.invoices'
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(g.grants) AS k
      WHERE jsonb_typeof(k) = 'string' AND (k #>> '{}') LIKE 'section.%'
    )
  );
