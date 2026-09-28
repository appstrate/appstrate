-- 0032 — the three connection jsonb columns hold SETS, not single picks; and
-- the shared connections the old fallback picked implicitly become member pins.
--
-- Run BEFORE the drizzle batch, with the platform STOPPED. The window is:
-- stop → run this file → deploy the new image (`0077` applies at boot) →
-- reopen.
--
-- WHY that moment and not after the batch. It depends on nothing `0077` does —
-- the columns are jsonb and neither their type nor any constraint on them
-- moves — while the new readers raise on the old shape rather than degrade.
-- Rewriting with the platform down means no request ever meets an unrewritten
-- row. The order is safe in both directions: an array is what only the new code
-- reads, but the rows this file rewrites are not read again by the OLD code
-- either, since the old image is stopped the moment the rewrite starts.
-- The pin freeze below is the one part that DOES depend on the moment: it
-- reads `integration_org_defaults.connection_id` and writes
-- `integration_pins.connection_id`, the two scalar columns `0077` folds into
-- `connection_ids` and drops — so before the batch is the only time it can run.
--
-- (The `integration_connections.label` backfill that `0077`'s `SET NOT NULL`
-- preconditions is NOT here: it lives in `0077` itself, licensed by
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
-- NOT rewritten, and nothing to do: the copy of
-- `package_schedules.connection_overrides` that each schedule's BullMQ job
-- carries in Redis. At boot the scheduler upserts the job of every enabled
-- schedule from its row — by then rewritten — BEFORE its worker starts, and
-- the upsert replaces the pending job with one built from the new data. A
-- job the sync skips (e.g. a schedule whose package is gone) still holds the
-- old shape; every fire validates the copy it reads and records a visible
-- failed run for it instead of launching (`apps/api/src/services/scheduler.ts`,
-- `initScheduleWorker` and `triggerScheduledRun`).
--
-- ═══ WHAT IT INSERTS — implicit shared picks frozen as member pins ═══
--
-- The resolver's last layer (the fallback, layer 7 of
-- `apps/api/src/services/integration-connection-resolver.ts`) used to
-- auto-bind the actor's single healthy ACCESSIBLE connection — own OR another
-- member's `shared_with_org = true` one. It now auto-binds the actor's OWN
-- connections only; a connection someone else shared is used after an explicit
-- choice (member pin, run/schedule override, org default), never implicitly.
-- A member whose runs silently leaned on a colleague's shared connection would
-- otherwise meet `not_connected` on the first run after the deploy.
--
-- So the pick the old fallback made for them is written down, as the member
-- pin they would have created had the picker asked. One pin per
-- (space, agent, integration, user), taken from the most recent qualifying run
-- of the last 30 days, where ALL of the following hold:
--
--   - the run's actor is a platform user (`user_id` set, `end_user_id` NULL)
--     and its agent is a real package (not deleted, not an inline shadow row);
--   - its resolved set for the integration is ONE connection whose source is
--     `fallback_auto`;
--   - that connection still exists in the run's space, on that integration,
--     is `shared_with_org = true`, is NOT owned by the user, and is healthy
--     (`needs_reconnection = false`);
--   - the old fallback would STILL pick it today: it is the only healthy
--     connection the user can reach there — no other healthy shared one, and
--     no healthy one of the user's own (the new fallback binds that one by
--     itself, so no pin is needed);
--   - nothing above the fallback decides today: no admin pin, no member pin of
--     that user, no org default the user can reach — a new member pin would
--     override a soft org default, which the old resolver did not do.
--
-- The pin row is what `upsertMemberPin` (`integration-pins-service.ts`)
-- inserts: `user_id` = `created_by` = the member, both timestamps `now()`.
-- It is written in the PRE-PR shape (scalar `connection_id`), because this file
-- runs before the batch; `0077` then folds it into `connection_ids` with every
-- other pin.
--
-- NOT covered: end-users. They own no member pins (the resolver never reads
-- one for them), so there is nothing to freeze. An end-user run that leaned on
-- a shared connection fails after the deploy until its API caller passes
-- `connection_overrides` on the run, or an admin pins the connection for the
-- agent. List the affected (space, agent, integration) triples with the
-- standalone end-user listing at the end of this file, before the window, and
-- hand them to whoever owns those callers.
--
-- Approximated, on the safe side: the old fallback first drops candidates on an
-- auth key the integration's CURRENT manifest no longer declares, and — when
-- the agent pins an `auth_key` — candidates on another auth. Neither filter is
-- reproduced here (both read manifests), so the uniqueness test counts every
-- healthy candidate of the integration. That can only SKIP a pin the old
-- fallback would have honoured, never write one it would not.
--
-- Placement: AFTER the three `UPDATE`s, inside the same transaction, so it
-- reads `runs.resolved_connections` in exactly one shape — the array the
-- rewrite leaves — on the first run and on every re-run alike.
--
-- One transaction, fenced. Three `UPDATE`s and one `INSERT`, no `DELETE`.
--
-- Re-running is safe BEFORE the batch: every candidate the first run pinned
-- now has a member pin, which the "no member pin" condition excludes, so the
-- `INSERT` matches zero rows (and `ON CONFLICT DO NOTHING` backs it). AFTER
-- the batch the file cannot half-apply: `0077` drops both `connection_id`
-- columns the freeze names, so it raises (42703) and — under psql's
-- `ON_ERROR_STOP` — the whole transaction rolls back, rewrite included.
--
-- Rows: NOT YET REHEARSED. Production holds rows in all three columns (every
-- run since the snapshot shipped carries `resolved_connections`), so this is
-- not a state no reachable database is in: rehearse against a restored dump
-- (README, "Writing one", requirement 4) and record the before/after counts
-- here BEFORE the window. The "after" counts must all read 0. The pin count is
-- sized by that rehearsal too: its query reads the rewritten shape, so it has
-- no standalone pre-flight twin below.
--
-- ROLLBACK: none is offered, and none is wanted. Collapsing an array back to
-- its first element is lossy the moment a run has bound more than one
-- connection, and it would restore a shape no deployed reader accepts. Recover
-- from the pre-run `pg_dump` instead. The frozen pins are ordinary member pins:
-- a member drops one from the agent page like any pin they set themselves.

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

-- ═══ FREEZE implicit shared picks as member pins ═══
--
-- One definition, read three times: count, insert, count again. A TEMP VIEW
-- rather than a table, so the "after" count re-evaluates against the pins the
-- `INSERT` just wrote; created and dropped inside the transaction, so an abort
-- leaves nothing behind. `connectionId` / `source` are the keys the pre-PR
-- resolver wrote into each element (`ResolvedConnection`, camelCase TS
-- serialised as-is). The connection is matched on `id::text`, so a malformed
-- snapshot value simply matches nothing instead of failing a `::uuid` cast.
CREATE TEMP VIEW _0032_implicit_shared_picks AS
SELECT DISTINCT ON (r.space_id, r.package_id, e.integration_id, r.user_id)
       r.space_id,
       r.package_id,
       e.integration_id,
       r.user_id,
       c.id AS connection_id
FROM runs r
CROSS JOIN LATERAL jsonb_each(r.resolved_connections) AS e(integration_id, v)
JOIN packages agent
  ON agent.id = r.package_id
 AND agent.ephemeral = false
JOIN integration_connections c
  ON c.id::text = e.v -> 0 ->> 'connectionId'
 AND c.space_id = r.space_id
 AND c.integration_package_id = e.integration_id
WHERE r.started_at >= now() - interval '30 days'
  -- platform user, not an end-user
  AND r.user_id IS NOT NULL
  AND r.end_user_id IS NULL
  -- a single connection, picked by the fallback
  AND r.resolved_connections IS NOT NULL
  AND jsonb_typeof(e.v) = 'array'
  AND jsonb_array_length(e.v) = 1
  AND e.v -> 0 ->> 'source' = 'fallback_auto'
  -- still someone else's shared, healthy connection
  AND c.shared_with_org = true
  AND c.user_id IS DISTINCT FROM r.user_id
  AND c.needs_reconnection = false
  -- the old fallback would still pick it: no OTHER healthy connection the user
  -- can reach there — neither another shared one nor one of their own
  AND NOT EXISTS (
    SELECT 1 FROM integration_connections o
    WHERE o.space_id = r.space_id
      AND o.integration_package_id = e.integration_id
      AND o.id <> c.id
      AND o.needs_reconnection = false
      AND (o.shared_with_org = true OR o.user_id = r.user_id))
  -- no layer above the fallback decides: no admin pin, no member pin of theirs
  AND NOT EXISTS (
    SELECT 1 FROM integration_pins p
    WHERE p.space_id = r.space_id
      AND p.package_id = r.package_id
      AND p.integration_package_id = e.integration_id
      AND (p.user_id IS NULL OR p.user_id = r.user_id))
  -- … and no org default whose connection the user can reach
  AND NOT EXISTS (
    SELECT 1 FROM integration_org_defaults d
    JOIN integration_connections dc ON dc.id = d.connection_id
    WHERE d.space_id = r.space_id
      AND d.integration_package_id = e.integration_id
      AND dc.space_id = r.space_id
      AND dc.integration_package_id = e.integration_id
      AND (dc.shared_with_org = true OR dc.user_id = r.user_id))
ORDER BY r.space_id, r.package_id, e.integration_id, r.user_id, r.started_at DESC;

SELECT count(*) AS implicit_shared_picks_before FROM _0032_implicit_shared_picks;

INSERT INTO integration_pins
  (space_id, package_id, integration_package_id, user_id, connection_id,
   created_by, created_at, updated_at)
SELECT space_id, package_id, integration_id, user_id, connection_id,
       user_id, now(), now()
FROM _0032_implicit_shared_picks
ON CONFLICT DO NOTHING;

-- must print 0: every pick now has a member pin, which the view excludes
SELECT count(*) AS implicit_shared_picks_after FROM _0032_implicit_shared_picks;

DROP VIEW _0032_implicit_shared_picks;

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
--
-- ═══ Standalone listing — end-user runs this file does NOT cover ═══
--
-- Read-only, before the window. The (space, agent, integration) triples whose
-- end-user runs of the last 30 days were bound by the fallback to a shared
-- connection the end-user does not own. After the deploy those runs fail until
-- the API caller passes `connection_overrides`, or an admin pins the
-- connection for the agent. Shape-agnostic on purpose: it reads the scalar
-- element before the window and the one-element array after it.
--
--   SELECT r.space_id, r.package_id, e.integration_id,
--          count(DISTINCT r.end_user_id) AS end_users,
--          max(r.started_at)             AS last_run
--   FROM runs r
--   CROSS JOIN LATERAL jsonb_each(r.resolved_connections) AS e(integration_id, v)
--   CROSS JOIN LATERAL (SELECT CASE jsonb_typeof(e.v) WHEN 'array' THEN e.v -> 0 ELSE e.v END) AS s(pick)
--   JOIN integration_connections c
--     ON c.id::text = s.pick ->> 'connectionId'
--    AND c.space_id = r.space_id
--   WHERE r.started_at >= now() - interval '30 days'
--     AND r.end_user_id IS NOT NULL
--     AND s.pick ->> 'source' = 'fallback_auto'
--     AND c.shared_with_org = true
--     AND c.end_user_id IS DISTINCT FROM r.end_user_id
--   GROUP BY r.space_id, r.package_id, e.integration_id
--   ORDER BY last_run DESC;
