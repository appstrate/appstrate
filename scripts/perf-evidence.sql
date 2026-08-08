-- SPDX-License-Identifier: Apache-2.0
--
-- Production evidence for the two performance questions that cannot be answered
-- from the source tree. Read-only: no DDL, no writes, safe on a live primary
-- (every statement is a catalog read or a bounded sample).
--
--   psql "$DATABASE_URL" -f scripts/perf-evidence.sql
--
-- Question 1 — is a slimmer run-list DTO worth breaking the response contract?
--   The list endpoints ship `input`, `result`, `checkpoint`, `context_snapshot`
--   and friends in full. Dropping them from list responses is a public contract
--   change, so it needs a number first: how many bytes per row are actually at
--   stake, at p50 and p95, versus the rest of the row.
--
-- Question 2 — are the prefix indexes redundant?
--   An index whose column list is a strict prefix of another index on the same
--   table is functionally covered by it — but "covered" is not "useless": the
--   shorter index is smaller, cheaper to keep cached, and the planner may still
--   prefer it (locally, Postgres picked `idx_run_logs_run_id` over the wider
--   composite for a `run_id` lookup). Section 2 reports usage, size and the
--   stats window; dropping anything without an `EXPLAIN (ANALYZE, BUFFERS)` on
--   the real queries is guesswork.

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
    pg_column_size(config)           AS config_bytes,
    pg_column_size(config_override)  AS config_override_bytes,
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
    ('config', config_bytes),
    ('config_override', config_override_bytes),
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
WHERE s.relname IN ('runs', 'run_logs', 'llm_usage', 'notifications', 'documents')
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
