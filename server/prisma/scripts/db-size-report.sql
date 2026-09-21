-- Database size report: where the bytes are.
--
-- READ-ONLY. Run through a real SQL client so the rows are visible
-- (`prisma db execute` discards result rows):
--
--   docker run --rm postgres:17-alpine psql "$DIRECT_URL" -f - < prisma/scripts/db-size-report.sql
--
-- or `npm run db:report:size` from server/ (prints the target host first).
--
-- History: on 2026-09-21 this showed raw_analytics_events at 3258 MB of a
-- 3623 MB database (4.5 M rows, 1.37 GB of indexes). That table is only ever
-- read for the trailing 24 h by the two analytics aggregators, so it is the
-- first candidate for retention when the number grows again.

\echo '=== database ==='
SELECT current_database()                                   AS database,
       pg_size_pretty(pg_database_size(current_database())) AS total_size,
       version()                                             AS server;

\echo '=== top 20 tables (total = heap + toast + indexes) ==='
SELECT c.relname                                                  AS table,
       pg_size_pretty(pg_total_relation_size(c.oid))              AS total,
       pg_size_pretty(pg_relation_size(c.oid))                    AS heap,
       pg_size_pretty(COALESCE(pg_total_relation_size(c.reltoastrelid), 0)) AS toast,
       pg_size_pretty(pg_indexes_size(c.oid))                     AS indexes,
       s.n_live_tup                                               AS live_rows,
       s.n_dead_tup                                               AS dead_rows,
       s.last_autovacuum
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 20;

\echo '=== largest indexes ==='
SELECT i.indexrelname                                  AS index,
       i.relname                                       AS table,
       pg_size_pretty(pg_relation_size(i.indexrelid))  AS size,
       i.idx_scan                                      AS scans
FROM pg_stat_user_indexes i
ORDER BY pg_relation_size(i.indexrelid) DESC
LIMIT 15;

\echo '=== raw_analytics_events age profile ==='
SELECT date_trunc('month', occurred_at) AS month,
       count(*)                          AS rows
FROM raw_analytics_events
GROUP BY 1
ORDER BY 1;
