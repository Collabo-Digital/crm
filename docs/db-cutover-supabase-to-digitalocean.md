# Production DB cutover: Supabase → DigitalOcean Managed Postgres

Done on **2026-09-21**. Kept as the runbook for any future host move; the
procedure is a plain `pg_dump` / `pg_restore` plus a two-line env swap, because
the app only ever used Supabase as a Postgres host (no Auth, Storage, RLS,
extensions or functions — see the survey notes at the bottom).

## Topology after the move

| | Value |
|---|---|
| Cluster | `collabo-crm-prod`, PostgreSQL 17, BLR1, Basic 1 vCPU / 1 GB / 10 GiB, storage autoscaling on |
| Direct | `collabo-crm-prod-do-user-27170801-0.g.db.ondigitalocean.com:25060/defaultdb?sslmode=require` → `DIRECT_URL` (Prisma Migrate only) |
| Pool | same host `:25061/crm` (PgBouncer, **transaction** mode, size 15) `?pgbouncer=true&connection_limit=10&pool_timeout=20&sslmode=require` → `DATABASE_URL` |
| Trusted sources | the droplet `crm-collabo` only. Add a laptop IP temporarily when running `prisma/scripts/*` locally, then remove it. |
| Network | the droplet (10.47.0.5) is **not** in the cluster's VPC (10.122.0.0/20), so the **public** hostname is used, not the `private-` one. TLS is mandatory. |
| API | unchanged: `/opt/crm/server` on the droplet, `docker compose`, `collabo-api` + `collabo-redis` + `collabo-caddy` |

`sslmode=require` on **both** URLs is not optional. Without it the container
restart-loops on `prisma migrate deploy` (its entrypoint), which looks like a
migration failure but is a refused plaintext connection.

## Why the DB was 3.6 GB

`raw_analytics_events` (Shopify Web Pixel + cart webhook events) held
3258 MB of 3623 MB: 4.5 M rows, 1.37 GB of it indexes. The only readers are the
two hourly aggregators in `server/src/analytics/`, and they read the trailing
hour (24 h for the replay path). Nothing deleted old rows. Growth is about
0.8 GB / month. `npm run db:report:size` prints the current breakdown; a
retention job for that table is the follow-up (`docs/` will link it here).

## Procedure (as run)

All commands on the droplet as root. The Postgres client must be ≥ the server
major (17), so the `postgres:17-alpine` image is used; the droplet's older
`postgres:16-alpine` cannot dump a 17 server.

```bash
mkdir -p /root/dbdump && docker pull postgres:17-alpine
# source URL taken from the running container, never typed:
docker exec collabo-api sh -c 'printf %s "$DIRECT_URL"' > /root/supabase_direct_url
# target URL placed by the operator via the DO console:
#   echo '<direct connection string>' > /root/do_direct_url ; chmod 600 both files
```

### 1. Rehearsal (app still running, zero risk)

```bash
docker run --rm -v /root/dbdump:/dump -e PGURL="$(cat /root/supabase_direct_url)" postgres:17-alpine \
  sh -c 'pg_dump "$PGURL" -Fc -n public --no-owner --no-privileges -f /dump/rehearsal.dump'

docker run --rm -v /root/dbdump:/dump -e PGURL="$(cat /root/do_direct_url)" postgres:17-alpine \
  sh -c 'pg_restore -d "$PGURL" -j2 --no-owner --no-privileges /dump/rehearsal.dump'
```

Verify on the target: `_prisma_migrations` rows with `finished_at IS NOT NULL`
equals the count on the source (56 on 2026-09-21), and row counts of `orders`,
`invoices`, `products`, `customers`, `users`, `raw_analytics_events` match.

### 2. Cutover

```bash
cd /opt/crm/server
cp .env .env.bak-supabase-$(date +%F)              # rollback copy
docker compose stop api                           # stops API + crons + BullMQ workers
# fresh, consistent dump (nothing can write now)
docker run --rm -v /root/dbdump:/dump -e PGURL="$(cat /root/supabase_direct_url)" postgres:17-alpine \
  sh -c 'pg_dump "$PGURL" -Fc -n public --no-owner --no-privileges -f /dump/final.dump'
# replace the rehearsal copy
docker run --rm -v /root/dbdump:/dump -e PGURL="$(cat /root/do_direct_url)" postgres:17-alpine \
  sh -c 'pg_restore -d "$PGURL" -j2 --clean --if-exists --no-owner --no-privileges /dump/final.dump'
# swap ONLY the two DB lines. Do NOT sed the URL into .env: the `&` in the
# query string is "matched text" to sed and the first attempt on 2026-09-21
# produced a garbage DATABASE_URL (Prisma P1013). Rebuild the file instead:
DIRECT=$(cat /root/do_direct_url)
POOL=$(printf %s "$DIRECT" | sed -E 's#:25060/defaultdb\?#:25061/crm?pgbouncer=true\&connection_limit=10\&pool_timeout=20\&#')
grep -vE '^(DATABASE_URL|DIRECT_URL)=' ".env.bak-supabase-$(date +%F)" > .env.new
printf 'DATABASE_URL=%s\nDIRECT_URL=%s\n' "$POOL" "$DIRECT" >> .env.new
chmod 600 .env.new && mv .env.new .env
grep -E '^(DATABASE_URL|DIRECT_URL)=' .env | sed -E 's#://([^:]+):[^@]*@#://\1:***@#'   # eyeball both lines
docker compose up -d --force-recreate api
docker compose logs -f api      # expect the DO host in the Datasource line, "No pending migrations", then Nest listening
```

### 3. Verify

- `docker compose ps` → api healthy, caddy up.
- `curl -s -o /dev/null -w '%{http_code}' https://api.collabo.store/api/v1` → 200
  (the `sslip.io` name in `.env.example` is a stale example; prod Caddy
  serves `api.collabo.store`, frontend is `app.collabo.store`).
- As run on 2026-09-21: api stopped 09:38:31 UTC, final dump 78 s (370 MB),
  restore 790 s, api back 09:57:16 UTC — **19 min downtime**. All row and
  object counts matched exactly before the env swap. Supabase afterwards
  showed only its own internal connections (`supabase_admin`, `postgrest`,
  `Supavisor`), none from the app.
- Row counts on DO equal the final-dump counts.
- App: login, orders list, open an order, product edit; logs free of
  `SSL`, `pool_timeout`, `ECONNREFUSED`.
- Supabase dashboard shows no new connections.

### Rollback

Only clean **before** the first customer write lands on DO:

```bash
cd /opt/crm/server && cp .env.bak-supabase-<date> .env && docker compose up -d --force-recreate api
```

## After

- Leave Supabase untouched for a few days, then pause/delete the project and
  downgrade the org. Deleting it also retires the old DB password, which was
  exposed in an operator session log during the move.
- `rm /root/supabase_direct_url` once Supabase is gone; keep
  `/root/do_direct_url` (mode 600) — `db:report:size` and future dumps use it.
- Follow-up: retention cron for `raw_analytics_events` (30 days is generous;
  readers need 24 h).

## Survey notes (what made this a pure host swap)

- No `CREATE EXTENSION`, no RLS/policies, no Supabase roles or `auth.*`
  references, no functions/triggers/views, everything in `public`. Prisma
  datasource has no `previewFeatures` / `extensions`.
- Supabase's own schemas (`auth`, `storage`, `realtime`, `vault`, `graphql*`)
  and extensions (`uuid-ossp`, `pgcrypto`, `supabase_vault`) were never used
  by the app — hence `-n public`.
- All primary keys are app-side `cuid()`; nothing depends on a DB-side UUID
  generator.
- `prisma/scripts/print-target.js` compares **hostnames** only, so the DO
  pool/direct pair (same host, two ports) passes its guard.
