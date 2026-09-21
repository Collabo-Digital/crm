# Migration recovery (P3009 / P3018)

How to unstick a deployment when `prisma migrate deploy` refuses to run.

## Symptoms

The `collabo-api` container restart-loops. Its entrypoint is
`npx prisma migrate deploy && node dist/src/main`, so a migration that cannot
apply means the API never starts. Logs repeat one of:

- **P3018** — *"A migration failed to apply"*, with the Postgres error inline.
  This is the first failure; it records a failed row in `_prisma_migrations`.
- **P3009** — *"migrate found failed migrations in the target database, new
  migrations will not be applied"*. Every subsequent attempt. Prisma refuses to
  touch anything while a failed row exists, so **all** later migrations are
  blocked too, not just the broken one.

## Why it happens here

Most of this repo's recent migrations are hand-written and add constraints
(partial unique indexes Prisma cannot model — see the schema header). A
constraint-adding migration passes on a clean database and fails on one with
real history. Each such migration embeds its pre-flight query in a comment, but
nothing runs those against the target before deploy, so the mismatch surfaces
at deploy time.

Recovery is always the same shape: **read the error → fix the data → clear the
failed rows → redeploy.** Never edit a migration file that has already been
applied anywhere — Prisma checksums applied migrations, and changing the file
breaks deploy on every database where it succeeded.

## Driving a remote database from a local checkout

You do not need to exec into the container. `prisma.config.ts` reads
`env("DATABASE_URL")` after `dotenv/config`, and **dotenv does not override a
variable already set in the shell** — so exporting the deployed URL in your
terminal wins over `server/.env` without editing that file.

```bash
cd server
export DATABASE_URL="postgresql://...deployed-url..."
npx prisma migrate status
```

> **Always read the `Datasource` line Prisma prints before running anything
> destructive.** If it names the wrong region/host, the export did not take and
> you are about to modify the wrong database. When you are done, `unset
> DATABASE_URL` or close the terminal so a later command doesn't silently hit
> production.

Reads must go through a real SQL client (`psql` against `DIRECT_URL`; on the
droplet, `docker run --rm postgres:17-alpine psql "$DIRECT_URL"`).
`prisma db execute` runs a file but discards result rows — it only prints
"Script executed successfully", so you cannot inspect anything with it.

> ### `prisma db execute` hides the target database
>
> `migrate status` / `migrate deploy` echo the `Datasource` line. **`db execute`
> does not.** There is no feedback about where a data-fixing script landed.
>
> This bit us on 2026-08-03: a dedupe script was run believing `server/.env`
> still pointed at dev, but the file had been repointed to production for a
> deploy. It cancelled five live GST invoices with no review. They were
> restored — but `status` had been overwritten, so the restore reconstructed
> `ISSUED` rather than truly undoing.
>
> Two rules follow:
>
> 1. Run destructive scripts through their `npm run db:fix:*` entry, never
>    `prisma db execute` directly — those chain `prisma/scripts/print-target.js`,
>    which prints the host first and exits non-zero if `DATABASE_URL` is unset.
> 2. Reasoning that a script "must be a no-op" is not verification. Check the
>    host, then run it.

## Procedure

### 1. Read the actual failure

```sql
SELECT migration_name, started_at, finished_at, rolled_back_at,
       applied_steps_count, logs
FROM _prisma_migrations
WHERE migration_name = '<the migration name from the error>'
ORDER BY started_at;
```

`logs` holds the Postgres error. A constraint violation (`23505`, `23503`,
`23502`) means the data must change first — go to step 2. A connection or
timeout error means nothing is wrong with the data; skip to step 3.

Note how many rows come back. Repeated deploy attempts stack up multiple
incomplete rows for the same migration.

### 2. Fix the data

Use the migration's own embedded pre-flight query to find the offending rows,
review them, then correct them. Postgres reports only the *first* violating key,
so never assume the one id in the error is the whole list.

Where a fix is expected to be needed on more than one environment, commit it as
an idempotent script under `server/prisma/scripts/` with an npm entry, rather
than pasting ad-hoc SQL. See `dedupe-active-invoices.sql` below.

### 3. Clear the failed rows

`prisma migrate resolve --rolled-back "<name>"` is the documented route, but it
can leave rows behind when several failed attempts have accumulated — deploy
then keeps reporting P3009 even though resolve claims success. When that
happens, delete the incomplete rows directly:

```sql
DELETE FROM _prisma_migrations
WHERE migration_name = '<name>'
  AND finished_at IS NULL;
```

This is safe when the migration failed atomically (a single DDL statement) and
the file is written with `IF NOT EXISTS`, as this repo's hand-written ones are —
nothing was applied, so there is nothing to undo. For a multi-statement
migration, verify which statements landed before deleting anything.

### 4. Redeploy

```bash
npx prisma migrate deploy
npx prisma migrate status   # "Database schema is up to date!"
docker restart collabo-api
```

Then confirm the constraint the migration was trying to create actually exists:

```sql
SELECT indexname FROM pg_indexes WHERE indexname = '<index name>';
```

---

## Worked example: duplicate GST invoices (2026-08-03)

**Migration:** `20260729130000_one_active_invoice_per_order`, which creates
`UNIQUE invoices(order_id) WHERE status <> 'CANCELLED'` — at most one live
invoice per order.

**Error:**

```
23505 — could not create unique index "invoices_order_id_active_key"
DETAIL: Key (order_id)=(cmnk2jvhy003tw5ng7kr2lico) is duplicated.
```

**Cause:** the deployed database predates the guard in `createForOrderTx`
(`server/src/invoice/invoice.service.ts`) that rejects a second live invoice per
order, so double-submits had produced duplicates. The dev database was created
after the guard and was clean, which is why the migration's pre-flight passed
there. Twelve migrations were blocked behind it, including all nine Inventory V1
ones.

**Fix:** cancel every duplicate except the oldest per order, keeping the audit
trail intact (the partial index exempts `CANCELLED`, which is the statutory
cancel-then-reissue flow). The later invoice is the accident; the earlier one is
the document most likely already sent to the customer and filed.

```bash
npm run db:fix:dedupe-invoices
```

The script (`server/prisma/scripts/dedupe-active-invoices.sql`) is idempotent
and ends with a guard that raises if any duplicates survive, so a partial fix
cannot read as success. Review the diagnostic in its header before running it —
these are statutory records, and a duplicate already filed in a past GSTR return
needs an accounting amendment.

Then step 3 (delete the incomplete `_prisma_migrations` rows — `resolve` had
stopped clearing them after repeated attempts) and step 4.

## Preventing the next one

When writing a migration that adds a constraint to an existing table, run its
embedded pre-flight query against **every** target database — not just dev —
before deploying, and ship the corresponding data fix as a script in the same
change.
