-- 0018 — connections become SETS: the labels that address them, and the three
-- jsonb columns that hold them.
--
-- TWO SECTIONS, TWO MOMENTS. Run each at its own; do NOT feed the whole file
-- to psql in one go. Order is the plan's Déploiement section
-- (`docs/plans/multi-connection-per-integration.md` §9).
--
--   SECTION A — BEFORE the drizzle batch, platform STOPPED, and only when the
--               pre-flight below counts a row. `0069` promotes
--               `integration_connections.label` to NOT NULL; a single NULL
--               raises 23502 and rolls the WHOLE pending batch back, which is
--               a failed deploy discovered at boot. This is the `0009`/`0013`
--               shape: a guard whose precondition most deployments already
--               meet.
--   SECTION B — AFTER the batch has applied at boot, i.e. once the new image
--               is up, because it writes the shape only the new readers
--               accept.
--
-- ═══ WHAT SECTION A REPAIRS ═══
--
-- `label` is written on every insert — the extracted identity, else
-- "Connexion N" (`services/integration-connections.ts`, "no render-time
-- fallback, the label is always set") — so the column has held a value on
-- every row minted since that path existed. NOT NULL makes the invariant the
-- database's rather than the service's, because the sidecar's `connection`
-- tool parameter is a REQUIRED string enum keyed on the label: a nameless
-- connection is unaddressable, not merely unnamed.
--
-- The backfill mints exactly what the service would have: "Connexion N", N
-- being the row's 1-based rank by `created_at` inside its
-- `(space_id, integration_package_id, owner)` group — `owner` being
-- `user_id` or `end_user_id`, whichever the row carries. One statement, one
-- window function. Idempotent: `WHERE label IS NULL` is exactly the condition
-- it removes.
--
-- Numbering is over the NULL rows only, so it can collide with a "Connexion 2"
-- an existing sibling already holds. Deliberate: labels are not unique, the
-- collision is visible and user-editable, and the alternative — renumbering
-- rows a user may have named — would overwrite a decision this file has no
-- business overwriting.
--
-- ═══ WHAT SECTION B REWRITES ═══
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
-- Each section is one transaction, fenced. Four `UPDATE`s in total, no
-- `INSERT`, no `DELETE`.
--
-- Rows: UNMEASURED — rehearse against a restored dump (README, "Writing one",
-- requirement 4) and record what the before/after counts print. Every "after"
-- count must read 0.
--
-- ROLLBACK: none is offered for either section, and none is wanted. A minted
-- label is indistinguishable from one the service would have written, and
-- collapsing an array back to its first element is lossy the moment a run has
-- bound more than one connection — it would restore a shape no deployed reader
-- accepts. Recover from the pre-run `pg_dump` instead.

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION A — BEFORE the drizzle batch, platform STOPPED.                   ║
-- ║ Run this section ALONE, and only when the pre-flight counts a row.        ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ═══ VERIFY (before) — nameless connections, i.e. what would break 0069 ═══
SELECT count(*) AS unlabelled_connections_before
FROM integration_connections
WHERE label IS NULL;

UPDATE integration_connections c
SET label = 'Connexion ' || r.rank
FROM (
  SELECT id,
         row_number() OVER (
           PARTITION BY space_id, integration_package_id, coalesce(user_id, end_user_id)
           ORDER BY created_at, id
         ) AS rank
  FROM integration_connections
  WHERE label IS NULL
) r
WHERE c.id = r.id
  AND c.label IS NULL;

-- ═══ VERIFY (after) — must print 0, or 0069 will raise 23502 at boot ═══
SELECT count(*) AS unlabelled_connections_after
FROM integration_connections
WHERE label IS NULL;

COMMIT;

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION B — AFTER the drizzle batch has applied at boot.                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

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
-- Section A's count decides whether section A runs at all. Anything above 0
-- means the drizzle batch would raise 23502 on `0069`, so run section A first,
-- with the platform stopped:
--
--   SELECT count(*) AS unlabelled_connections
--     FROM integration_connections
--    WHERE label IS NULL;
--
-- Section B's three counts, outside any transaction. Before the deploy they
-- size the work; after the run they must all read 0. A total of 0 BEFORE is not
-- by itself proof the section is unnecessary — pair it with the control below,
-- which counts every row that HAS a value, so "nothing to rewrite" and "nothing
-- at all" read differently.
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
