-- Changing the catalogue (prices, the stock counts in the product form,
-- variants, photos, deleting, bulk actions, CSV import) now needs
-- `products.edit` on top of the Products section (see src/auth/permissions.ts).
-- Hand it to every active Agent who can change products today, so nobody
-- loses that on deploy: those who hold the Products section, and those who
-- hold no section and no section-less job (they joined before section access
-- existed and open everything). Viewers never could change products.
--
-- Except the Packer, Warehouse and Cashier jobs, which were never meant to:
-- a member whose stored preset names one of them, or whose grants are exactly
-- one of those templates. The app does not store the preset, so the grants
-- are the record. Today's Cashier holds the till alone, which opens no
-- Products; its first version also held the Products section.
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
      g.grants || '["products.edit"]'::jsonb
    )
FROM (
  SELECT "id",
         CASE WHEN jsonb_typeof("permissions"->'grants') = 'array' THEN "permissions"->'grants' ELSE '[]'::jsonb END AS grants
  FROM "organization_members"
) AS g
WHERE g."id" = m."id"
  AND m."role" = 'AGENT'
  AND m."is_active" = true
  AND NOT g.grants ? 'products.edit'
  AND (
    g.grants ? 'section.products'
    OR NOT (
      g.grants ?| ARRAY['section.dashboard', 'section.orders', 'section.products', 'section.customers', 'section.invoices',
                        'section.analytics', 'section.chat', 'section.campaigns', 'section.logistics']
      OR g.grants ? 'pos.sell'
    )
  )
  AND COALESCE(m."permissions"->>'preset', '') NOT IN ('packer', 'warehouse', 'cashier')
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('["section.products", "inventory.pack"]'::jsonb),
      ('["section.products", "inventory.view", "inventory.receive", "inventory.pick", "inventory.pack", "inventory.dispatch", "inventory.labels"]'::jsonb),
      ('["section.products", "pos.sell"]'::jsonb)
    ) AS job(grants)
    WHERE g.grants @> job.grants AND g.grants <@ job.grants
  );

UPDATE "team_invites" AS i
SET "permissions" = jsonb_set(
      CASE WHEN jsonb_typeof(i."permissions") = 'object' THEN i."permissions" ELSE '{}'::jsonb END,
      '{grants}',
      g.grants || '["products.edit"]'::jsonb
    )
FROM (
  SELECT "id",
         CASE WHEN jsonb_typeof("permissions"->'grants') = 'array' THEN "permissions"->'grants' ELSE '[]'::jsonb END AS grants
  FROM "team_invites"
) AS g
WHERE g."id" = i."id"
  AND i."role" = 'AGENT'
  AND i."status" = 'PENDING'
  AND NOT g.grants ? 'products.edit'
  AND (
    g.grants ? 'section.products'
    OR NOT (
      g.grants ?| ARRAY['section.dashboard', 'section.orders', 'section.products', 'section.customers', 'section.invoices',
                        'section.analytics', 'section.chat', 'section.campaigns', 'section.logistics']
      OR g.grants ? 'pos.sell'
    )
  )
  AND COALESCE(i."permissions"->>'preset', '') NOT IN ('packer', 'warehouse', 'cashier')
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('["section.products", "inventory.pack"]'::jsonb),
      ('["section.products", "inventory.view", "inventory.receive", "inventory.pick", "inventory.pack", "inventory.dispatch", "inventory.labels"]'::jsonb),
      ('["section.products", "pos.sell"]'::jsonb)
    ) AS job(grants)
    WHERE g.grants @> job.grants AND g.grants <@ job.grants
  );
