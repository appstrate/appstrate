-- 0018 — the three connection jsonb columns hold SETS, not single picks.
--
-- Run BEFORE the drizzle batch, with the platform STOPPED. The window is:
-- stop → run this file → deploy the new image (`0069` applies at boot) →
-- reopen. Order is the plan's Déploiement section
-- (`docs/plans/multi-connection-per-integration.md` §9).
--
-- WHY that moment and not after the batch. It depends on nothing `0069` does —
-- the columns are jsonb and neither their type nor any constraint on them
-- moves — while the new readers raise on the old shape rather than degrade.
-- Rewriting with the platform down means no request ever meets an unrewritten
-- row. The order is safe in both directions: an array is what only the new code
-- reads, but the rows this file rewrites are not read again by the OLD code
-- either, since the old image is stopped the moment the rewrite starts.
--
-- (The `integration_connections.label` backfill that `0069`'s `SET NOT NULL`
-- preconditions is NOT here: it lives in `0069` itself, licensed by
-- `docs/NO_TRANSITIONAL_CODE.md` §2, "the precondition of a constraint".)
--
-- ═══ WHAT IT REWRITES ═══
--
-- An integration now binds 1..N connections per run, so three snapshot columns
-- change SHAPE (not type — all three stay jsonb):
--
--   runs.connection_overrides              { id: "<uuid>" }   → { id: ["<uuid>"] }
--   runs.resolved_connections              { id: {…} }        → { id: [{…}] }
--   package_schedules.connection_overrides { id: "<uuid>" }   → { id: ["<uuid>"] }
--
-- The new readers expect an array and there is no scalar path left to fall
-- back to — that is the doctrine (`docs/NO_TRANSITIONAL_CODE.md`), and it is
-- what makes this file necessary rather than optional. A row left in the old
-- shape fails loudly at the next read; `runs.resolved_connections` in
-- particular is read long after kickoff by the live-credentials route, so a
-- finished-but-still-referenced run is not a safe thing to skip.
--
-- Values ALREADY an array are left untouched, which is what makes the file
-- idempotent: the `EXISTS (… jsonb_typeof(v) <> 'array')` guard is exactly the
-- condition each `UPDATE` removes, so a second run matches zero rows. It also
-- leaves `{}` alone — `jsonb_object_agg` over zero pairs returns NULL, and an
-- empty map must stay an empty map rather than become NULL.
--
-- One transaction, fenced. Three `UPDATE`s, no `INSERT`, no `DELETE`.
--
-- Rows: UNMEASURED — rehearse against a restored dump (README, "Writing one",
-- requirement 4) and record what the before/after counts print. The "after"
-- counts must all read 0.
--
-- ROLLBACK: none is offered, and none is wanted. Collapsing an array back to
-- its first element is lossy the moment a run has bound more than one
-- connection, and it would restore a shape no deployed reader accepts. Recover
-- from the pre-run `pg_dump` instead.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ═══ VERIFY (before) — rows still holding a non-array value ═══
SELECT
  (SELECT count(*) FROM runs r
    WHERE r.connection_overrides IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(r.connection_overrides) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS runs_overrides_before,
  (SELECT count(*) FROM runs r
    WHERE r.resolved_connections IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(r.resolved_connections) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS runs_resolved_before,
  (SELECT count(*) FROM package_schedules s
    WHERE s.connection_overrides IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(s.connection_overrides) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS schedules_overrides_before;

UPDATE runs
SET connection_overrides = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END)
  FROM jsonb_each(connection_overrides) AS e(k, v)
)
WHERE connection_overrides IS NOT NULL
  AND EXISTS (SELECT 1 FROM jsonb_each(connection_overrides) AS e(k, v)
               WHERE jsonb_typeof(v) <> 'array');

UPDATE runs
SET resolved_connections = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END)
  FROM jsonb_each(resolved_connections) AS e(k, v)
)
WHERE resolved_connections IS NOT NULL
  AND EXISTS (SELECT 1 FROM jsonb_each(resolved_connections) AS e(k, v)
               WHERE jsonb_typeof(v) <> 'array');

UPDATE package_schedules
SET connection_overrides = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END)
  FROM jsonb_each(connection_overrides) AS e(k, v)
)
WHERE connection_overrides IS NOT NULL
  AND EXISTS (SELECT 1 FROM jsonb_each(connection_overrides) AS e(k, v)
               WHERE jsonb_typeof(v) <> 'array');

-- ═══ VERIFY (after) — all three must print 0 ═══
SELECT
  (SELECT count(*) FROM runs r
    WHERE r.connection_overrides IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(r.connection_overrides) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS runs_overrides_after,
  (SELECT count(*) FROM runs r
    WHERE r.resolved_connections IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(r.resolved_connections) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS runs_resolved_after,
  (SELECT count(*) FROM package_schedules s
    WHERE s.connection_overrides IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_each(s.connection_overrides) AS e(k, v)
                   WHERE jsonb_typeof(v) <> 'array'))            AS schedules_overrides_after;

COMMIT;

-- ═══ Standalone counts — run read-only, before the window and after the fact ═══
--
-- The same three counts, outside any transaction. Before the window they size
-- the work; after the run they must all read 0. A total of 0 BEFORE is not by
-- itself proof the file is unnecessary — pair it with the control below, which
-- counts every row that HAS a value, so "nothing to rewrite" and "nothing at
-- all" read differently.
--
--   SELECT
--     (SELECT count(*) FROM runs r
--       WHERE r.connection_overrides IS NOT NULL
--         AND EXISTS (SELECT 1 FROM jsonb_each(r.connection_overrides) AS e(k, v)
--                      WHERE jsonb_typeof(v) <> 'array'))          AS runs_overrides_todo,
--     (SELECT count(*) FROM runs r
--       WHERE r.resolved_connections IS NOT NULL
--         AND EXISTS (SELECT 1 FROM jsonb_each(r.resolved_connections) AS e(k, v)
--                      WHERE jsonb_typeof(v) <> 'array'))          AS runs_resolved_todo,
--     (SELECT count(*) FROM package_schedules s
--       WHERE s.connection_overrides IS NOT NULL
--         AND EXISTS (SELECT 1 FROM jsonb_each(s.connection_overrides) AS e(k, v)
--                      WHERE jsonb_typeof(v) <> 'array'))          AS schedules_overrides_todo,
--     -- control: rows carrying a non-empty map at all
--     (SELECT count(*) FROM runs WHERE connection_overrides <> '{}'::jsonb)             AS runs_overrides_total,
--     (SELECT count(*) FROM runs WHERE resolved_connections <> '{}'::jsonb)             AS runs_resolved_total,
--     (SELECT count(*) FROM package_schedules WHERE connection_overrides <> '{}'::jsonb) AS schedules_overrides_total;
