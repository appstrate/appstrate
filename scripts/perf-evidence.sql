-- SPDX-License-Identifier: Apache-2.0
--
-- Production evidence for two performance questions that CANNOT be answered
-- from the source tree — only from a live database with real rows and real
-- planner statistics.
--
--   psql "$DATABASE_URL" -f scripts/perf-evidence.sql
--
-- STANDING OPERATOR TOOL, not one-off evidence-gathering. It is deliberately
-- referenced by no `bun run` script, no workflow and no test — same posture,
-- and same reason, as `scripts/check-index-drift.ts`: it needs a production
-- connection string, so it is run by a human on a jump host, never by CI. Both
-- sections are generic — no table, index or column list is hard-coded to a
-- particular audit — so the script keeps answering its questions after the
-- schema moves on. `DATABASE_URL` is the only input.
--
-- READ-ONLY. No DDL, no writes, safe on a live primary: every statement is a
-- catalog read or a bounded sample. It takes no locks a reader does not.
--
-- WHEN TO RE-RUN
--   Section 1 — before deciding whether to slim the run-list DTO (see below),
--     and again after any change to which `runs` columns the list projects.
--   Section 2 — after any release that ADDS indexes, and before any
--     `DROP INDEX`. Its finding class recurs by construction: every new
--     composite can turn an existing narrow index into a prefix duplicate.
--   Both — before a release that claims a performance win on these paths.
--
-- ============================ THE TWO QUESTIONS ============================
--
-- Question 1 — is a slimmer run-list DTO worth breaking the response contract?
--   STATUS: OPEN. `enrichedRunColumns` (`apps/api/src/services/state/runs.ts`)
--   still projects `input`, `result`, `checkpoint` and `context_snapshot`, and
--   `runRowToWireDto` still serialises them on EVERY row of EVERY list page.
--   Dropping them from list responses is a public contract change — `GET
--   /api/runs` declares `#/components/schemas/Run` and `detect:breaking` will
--   block it — so it needs a dated API version, and therefore a number first:
--   how many bytes per row are actually at stake, at p50 and p95, versus the
--   rest of the row. Sections 1a-1c are that number.
--
--   HOW TO READ IT. 1a ranks the JSONB columns by p95 weight against
--   `__whole_row__`; 1b converts that to what one 20-row page carries and what
--   share of it is droppable; 1c counts the tail. The decision rule the author
--   of a slimming PR owes a reviewer: if `droppable_pct_at_p95` is small, the
--   contract break buys nothing and the answer is no. If it is large, 1c says
--   whether the win is broad or a handful of outliers — a fat tail argues for
--   capping the fields, not removing them.
--
-- Question 2 — are the prefix indexes redundant?
--   STATUS: the 2026-08 instance is CLOSED, the question is not. Migration
--   `0039_unique_nebula` dropped 18 indexes (13 of them strict leading-prefix
--   duplicates) and `0041_restore_squash_indexes` restored the two covers that
--   turned out to be missing from production. Section 2a is the detector that
--   finds the NEXT batch, not a record of that one.
--
--   HOW TO READ IT. 2a lists every non-unique, non-partial index whose columns
--   are a strict left prefix of another index on the same table. "Covered" is
--   not "useless": the shorter index is smaller, cheaper to keep cached, and
--   the planner may still prefer it (locally, Postgres picked
--   `idx_run_logs_run_id` over the wider composite for a `run_id` lookup).
--   Treat a row as a CANDIDATE, never a verdict. Confirm with an
--   `EXPLAIN (ANALYZE, BUFFERS)` on the real query against production before
--   dropping anything — that is how `0039` justified its first entry, and it
--   is the only thing that distinguishes a dead index from a chosen one.
--   Read 2c strictly WITH section 0: an `idx_scan` of 0 over a stats window
--   younger than the query it is meant to serve proves nothing at all.
--
--   TWO TRAPS THIS SECTION IS ALREADY WRITTEN AROUND. A UNIQUE or PARTIAL
--   short index enforces or serves something the wide one does not, so it is
--   excluded — a prefix argument never reaches it. And a covering index that
--   the SCHEMA declares may simply not EXIST on production (`0000_init.sql` is
--   a squash and production predates it): 2a reads `pg_index`, so it can only
--   see what is really there, but the conclusion is worth stating anyway —
--   before any `DROP INDEX`, verify the SURVIVING index against the live
--   catalog. `scripts/check-index-drift.ts` is the tool for that half, and the
--   two are meant to be run together.
--
--   OPS NOTE. `DROP INDEX CONCURRENTLY` cannot run inside a transaction and
--   drizzle wraps the whole pending batch in one, so a drop migration must use
--   a plain `DROP INDEX` behind a `SET LOCAL lock_timeout` fence. `0039` is
--   the worked example.

\pset pager off
\timing off

\echo '=== 0. Stats window (an idx_scan of 0 means nothing without this) ==='
-- `stats_reset` is NULL when the counters were never explicitly reset, which
-- is the common case and tells you nothing on its own — hence the postmaster
-- start time and the data's own age as the fallback bounds on the window.
SELECT
  d.datname,
  d.stats_reset,
  now() - d.stats_reset          AS stats_age,
  pg_postmaster_start_time()     AS postmaster_started,
  now() - pg_postmaster_start_time() AS uptime,
  (SELECT min(started_at) FROM runs) AS oldest_run,
  (SELECT max(started_at) FROM runs) AS newest_run
FROM pg_stat_database d
WHERE d.datname = current_database();

\echo ''
\echo '=== 1a. runs: JSONB payload weight, p50 / p95 / max, over the last 10k rows ==='
WITH sample AS (
  SELECT
    pg_column_size(input)            AS input_bytes,
    pg_column_size(result)           AS result_bytes,
    pg_column_size(checkpoint)       AS checkpoint_bytes,
    pg_column_size(context_snapshot) AS context_bytes,
    pg_column_size(metadata)         AS metadata_bytes,
    pg_column_size(token_usage)      AS token_usage_bytes,
    pg_column_size(runs.*)           AS row_bytes
  FROM runs
  ORDER BY started_at DESC
  LIMIT 10000
)
SELECT
  column_name,
  count(*)                                                         AS rows_sampled,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY bytes)               AS p50_bytes,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY bytes)              AS p95_bytes,
  max(bytes)                                                       AS max_bytes,
  round(avg(bytes))                                                AS avg_bytes
FROM sample,
LATERAL (
  VALUES
    ('input', input_bytes),
    ('result', result_bytes),
    ('checkpoint', checkpoint_bytes),
    ('context_snapshot', context_bytes),
    ('metadata', metadata_bytes),
    ('token_usage', token_usage_bytes),
    ('__whole_row__', row_bytes)
) AS t(column_name, bytes)
WHERE bytes IS NOT NULL
GROUP BY column_name
ORDER BY p95_bytes DESC NULLS LAST;

\echo ''
\echo '=== 1b. What one list PAGE carries (20 rows), and how much of it is droppable ==='
WITH sample AS (
  SELECT
    coalesce(pg_column_size(input), 0)
      + coalesce(pg_column_size(result), 0)
      + coalesce(pg_column_size(checkpoint), 0)
      + coalesce(pg_column_size(context_snapshot), 0) AS droppable_bytes,
    pg_column_size(runs.*)                            AS row_bytes
  FROM runs
  ORDER BY started_at DESC
  LIMIT 10000
)
SELECT
  percentile_disc(0.5) WITHIN GROUP (ORDER BY row_bytes) * 20        AS page_p50_bytes,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY row_bytes) * 20       AS page_p95_bytes,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY droppable_bytes) * 20  AS droppable_p50_bytes,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY droppable_bytes) * 20 AS droppable_p95_bytes,
  round(
    100.0 * percentile_disc(0.95) WITHIN GROUP (ORDER BY droppable_bytes)
          / nullif(percentile_disc(0.95) WITHIN GROUP (ORDER BY row_bytes), 0)
  )                                                                  AS droppable_pct_at_p95
FROM sample;

\echo ''
\echo '=== 1c. The tail: runs whose droppable payload alone exceeds 100 kB ==='
SELECT
  count(*) FILTER (
    WHERE coalesce(pg_column_size(input), 0) + coalesce(pg_column_size(result), 0)
        + coalesce(pg_column_size(checkpoint), 0)
        + coalesce(pg_column_size(context_snapshot), 0) > 100 * 1024
  ) AS runs_over_100kb,
  count(*) AS runs_total
FROM runs;

\echo ''
\echo '=== 2a. Indexes whose columns are a strict PREFIX of another index (same table) ==='
WITH idx AS (
  SELECT
    i.indexrelid                 AS index_oid,
    c.relname                    AS index_name,
    i.indrelid::regclass::text   AS table_name,
    i.indrelid                   AS table_oid,
    -- `indkey` is an int2vector whose array form is ZERO-based, so slicing it
    -- with 1-based bounds silently compares the wrong columns (and quietly
    -- reports "no redundant indexes"). Going through its text form yields an
    -- ordinary 1-based int[].
    string_to_array(i.indkey::text, ' ')::int[]     AS cols,
    i.indisunique                                  AS is_unique,
    pg_get_expr(i.indpred, i.indrelid) IS NOT NULL AS is_partial
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
)
SELECT
  short.table_name,
  short.index_name                                    AS redundant_candidate,
  wide.index_name                                     AS covered_by,
  pg_size_pretty(pg_relation_size(short.index_oid))   AS candidate_size,
  pg_size_pretty(pg_relation_size(wide.index_oid))    AS covering_size,
  s.idx_scan                                          AS candidate_scans,
  w.idx_scan                                          AS covering_scans,
  short.is_unique                                     AS candidate_unique,
  short.is_partial                                    AS candidate_partial
FROM idx short
JOIN idx wide
  ON wide.table_oid = short.table_oid
 AND wide.index_oid <> short.index_oid
 AND array_length(wide.cols, 1) > array_length(short.cols, 1)
 AND wide.cols[1:array_length(short.cols, 1)] = short.cols
LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = short.index_oid
LEFT JOIN pg_stat_user_indexes w ON w.indexrelid = wide.index_oid
-- A UNIQUE or PARTIAL short index enforces/serves something the wide one does
-- not; it is never redundant on column-prefix grounds alone.
WHERE NOT short.is_unique
  AND NOT short.is_partial
ORDER BY pg_relation_size(short.index_oid) DESC;

\echo ''
\echo '=== 2b. Write amplification: index count and total index bytes per hot table ==='
-- Join on `relid`, not on `relname`: the name is ambiguous between the two
-- catalogs (and would match same-named relations in other schemas).
SELECT
  s.relname                                                AS table_name,
  s.n_tup_ins + s.n_tup_upd + s.n_tup_del                  AS writes_since_reset,
  (SELECT count(*) FROM pg_index i WHERE i.indrelid = s.relid) AS index_count,
  pg_size_pretty(pg_indexes_size(s.relid))                 AS total_index_size,
  pg_size_pretty(pg_relation_size(s.relid))                AS heap_size
FROM pg_stat_user_tables s
WHERE s.relname IN ('runs', 'run_logs', 'llm_usage', 'notifications', 'files')
ORDER BY writes_since_reset DESC;

\echo ''
\echo '=== 2c. Never-scanned indexes (read WITH section 0 — a young stats window proves nothing) ==='
SELECT
  relname       AS table_name,
  indexrelname  AS index_name,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 40;
