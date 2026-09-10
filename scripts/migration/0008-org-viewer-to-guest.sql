-- 0008 — retire the org role `viewer`.
--
-- Run AFTER `packages/db/drizzle/0056_space_roles.sql` (which adds `guest` to
-- the `org_role` type and creates `space_members`) and BEFORE bringing the new
-- application version up. Between 0056 and this script a member whose row still
-- reads `viewer` gets a 500 (no permission set exists for that value); run it in
-- the same maintenance window.
--
-- Three sets move: org members (step 2), pending invitations (step 3) and the
-- OIDC clients that auto-provision on signup (step 4). `0056` already flipped
-- `oauth_clients.signup_role` to `guest` — that write preconditions its CHECK —
-- and left the space snapshot to this script, which is where a one-off data
-- rewrite belongs (`docs/NO_TRANSITIONAL_CODE.md` §2).
--
-- `signup_role = 'guest'` is what identifies a pre-`0056` viewer client here.
-- Before `0056` the column's CHECK was `IN ('admin', 'member', 'viewer')`
-- (`packages/db/drizzle/0003_fold_oidc_tables.sql`), so `guest` was unwritable,
-- and this script runs before the new application starts, so nothing has
-- written one since. Inside that window the value is exact.
--
-- Why the rewrite is `guest` + explicit rows and not simply `member`:
-- read-only-everywhere is a SPACE concern now. `guest` alone would take those
-- users' access away; `member` alone would GIVE them the open spaces' default
-- preset, which is `operator` — write access they never had. `guest` plus a
-- `viewer` row in every space that exists today reproduces their reach exactly,
-- and does not widen onto spaces created later. RBAC spec §11, decision 6.
--
-- Idempotent, steps 1-3: every WHERE is exactly the condition it removes, so a
-- second run matches zero rows, and step 1 additionally uses
-- `ON CONFLICT DO NOTHING`, so a partially-applied database converges.
--
-- Step 4 is the exception, and it is guarded MECHANICALLY — a comment saying
-- "run this once" is not a guard. Its predicate (`signup_role = 'guest'` with
-- an empty snapshot) is permanent, not window-scoped: once the new application
-- is up it re-matches any client an admin DELIBERATELY left with no space
-- assignments, and a second run would hand that client `viewer` rows in every
-- space created since — a widening of the auto-provisioning path. So a run that
-- commits records itself in `drizzle.migration_scripts`, and every later run
-- captures an EMPTY step-4 set: steps 1-3 still converge, step 4 writes nothing
-- and NAMES the clients it would otherwise have widened. Nothing is left for
-- the next operator to remember.
--
-- Re-running step 4 on purpose — a first run made against the wrong database —
-- means deleting that row by hand, which is a deliberate act:
--   DELETE FROM drizzle.migration_scripts WHERE script = '0008-org-viewer-to-guest';
--
-- One transaction: a failure leaves nothing half-done. Fenced, per
-- `scripts/migration/README.md` requirement 3.
--
-- Rows: UNMEASURED — not rehearsed against a production dump at the time of
-- writing. Per README requirement 4 the counts are printed by the script
-- itself (steps 0 and 5) rather than asserted here; run it against a restored
-- `pg_dump` copy first and record the two sets of numbers.
--
-- ═══ VERIFY — the counts must DISCRIMINATE ═══
--
-- The script prints counts before and after, in one transaction, and verifies
-- membership, invitation and OAuth-client coverage. A query that returns 0
-- whether the work happened or not proves nothing
-- (`verification-must-discriminate`):
--
--   before: V viewers, S spaces reachable by them, P pending viewer
--           invitations, C legacy viewer OAuth clients
--   after:  0 viewers, 0 pending viewer invitations, every former viewer×space
--           pair covered by a row, and each pending invitation and OAuth
--           signup snapshot complete
--
-- Coverage is the discriminating half: "0 viewers left" alone is also what a
-- database with no viewers to begin with prints, and would hide a step 1 that
-- inserted nothing before step 2 erased the evidence. The script carries the
-- pre-flip viewer set in a temp table so step 5 can check every (user, space)
-- pair it owed a row, plus the pending invitation and OAuth client sets to
-- check every promised space assignment. It ABORTS the whole transaction when
-- any is missing.
--
--   -- Standalone re-check, after the fact:
--   SELECT
--     (SELECT count(*) FROM org_members     WHERE role = 'viewer')                AS viewers_left,
--     (SELECT count(*) FROM org_invitations WHERE role = 'viewer'
--                                             AND status = 'pending')             AS pending_left,
--     (SELECT count(*) FROM space_members   WHERE preset_role = 'viewer')         AS viewer_rows,
--     (SELECT count(*) FROM oauth_clients   WHERE signup_role = 'guest'
--                                             AND signup_space_assignments = '[]'::jsonb)
--                                                                                AS unsnapshotted_clients;
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '300s';

-- ═══ RUN-ONCE MARKER ════════════════════════════════════════════════════════
--
-- `drizzle` is the schema the migrator already keeps its journals in
-- (`__drizzle_migrations`, `ee_migrations`), so this bookkeeping row sits
-- outside the application schema: the app never reads it, drizzle never
-- generates from it, and `scripts/check-index-drift.ts` — which reads `public`
-- only — does not see it. The schema exists by the time this script runs (it
-- runs after the drizzle batch); `IF NOT EXISTS` is for a rehearsal replayed
-- into a bare database.
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.migration_scripts (
  script text        PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now()
);

-- ═══ 0. BEFORE — captured, not just printed ═════════════════════════════════
--
-- The viewer set goes into a temp table because step 2 destroys it: after the
-- role flip there is no way left to ask "who was a viewer", so the verification
-- in step 5 would have nothing to compare against and would degrade to "0
-- viewers left", which is also what a database with no viewers prints. Carrying
-- the set across is what makes step 5 discriminate.
--
-- `ON COMMIT DROP`: the table lives exactly as long as this transaction, so a
-- failed run leaves nothing behind and a re-run starts clean.
CREATE TEMP TABLE mig0008_viewers ON COMMIT DROP AS
  SELECT org_id, user_id FROM org_members WHERE role = 'viewer';
CREATE TEMP TABLE mig0008_invitations ON COMMIT DROP AS
  SELECT id, org_id FROM org_invitations WHERE role = 'viewer' AND status = 'pending';
-- Same reason as the two above: step 4 fills the snapshot, so afterwards there
-- is no way left to ask which clients owed one.
CREATE TEMP TABLE mig0008_oauth_clients ON COMMIT DROP AS
  SELECT id, referenced_org_id FROM oauth_clients
  WHERE signup_role = 'guest' AND signup_space_assignments = '[]'::jsonb
    -- The window, made mechanical: on every run after the first this NOT EXISTS
    -- is false, the captured set is empty and step 4 writes nothing. Applied to
    -- the CAPTURE rather than to step 4 so the step-5 coverage checks agree —
    -- they verify exactly what was captured.
    AND NOT EXISTS (
      SELECT 1 FROM drizzle.migration_scripts WHERE script = '0008-org-viewer-to-guest'
    );

-- Name what the stale predicate would have taken, so a second run is legible
-- rather than silently narrower than the first.
DO $$
DECLARE
  v_ran_at timestamptz;
  v_would  text;
BEGIN
  SELECT ran_at INTO v_ran_at
    FROM drizzle.migration_scripts WHERE script = '0008-org-viewer-to-guest';
  IF NOT FOUND THEN RETURN; END IF;
  SELECT string_agg(id, ', ' ORDER BY id) INTO v_would FROM oauth_clients
    WHERE signup_role = 'guest' AND signup_space_assignments = '[]'::jsonb;
  RAISE NOTICE '0008 already ran at % — step 4 SKIPPED. OAuth signup client(s) its predicate matches today, and would have widened onto every space created since: %. Steps 1-3 re-run and match zero rows.',
    v_ran_at, COALESCE(v_would, 'none');
END $$;

DO $$
DECLARE
  v_viewers    bigint;
  v_expected   bigint;
  v_existing   bigint;
  v_pending    bigint;
  v_clients     bigint;
BEGIN
  SELECT count(*) INTO v_viewers FROM mig0008_viewers;
  -- The viewer x space product: how many (user, space) pairs must be covered
  -- by a `space_members` row once step 1 has run.
  SELECT count(*) INTO v_expected
    FROM mig0008_viewers v JOIN spaces s ON s.org_id = v.org_id;
  -- Pairs an admin already granted by hand. Step 1 leaves those alone
  -- (`ON CONFLICT DO NOTHING`), so they are part of the coverage but not part
  -- of the delta — which is why step 5 checks coverage and not the delta.
  SELECT count(*) INTO v_existing
    FROM mig0008_viewers v
    JOIN spaces s ON s.org_id = v.org_id
    JOIN space_members m ON m.space_id = s.id AND m.user_id = v.user_id;
  SELECT count(*) INTO v_pending
    FROM org_invitations WHERE role = 'viewer' AND status = 'pending';
  SELECT count(*) INTO v_clients FROM mig0008_oauth_clients;
  RAISE NOTICE 'before: % org viewer(s), % (user, space) pair(s) to cover, % already covered by a hand-added row, % pending viewer invitation(s), % legacy viewer OAuth client(s)',
    v_viewers, v_expected, v_existing, v_pending, v_clients;
END $$;

-- ═══ 1. Every viewer becomes an explicit `viewer` in every space they reach ══
--
-- Every space that exists NOW, which is exactly today's reach. A space created
-- after this runs does not get a row, which is the point of the split.
-- `ON CONFLICT DO NOTHING`: a re-run, or a row an admin already added by hand,
-- is left alone rather than overwritten.
INSERT INTO space_members (space_id, user_id, preset_role)
SELECT s.id, v.user_id, 'viewer'
FROM mig0008_viewers v
JOIN spaces s ON s.org_id = v.org_id
ON CONFLICT (space_id, user_id) DO NOTHING;

-- ═══ 2. The org role itself ═════════════════════════════════════════════════
UPDATE org_members SET role = 'guest' WHERE role = 'viewer';

-- ═══ 3. Pending invitations ═════════════════════════════════════════════════
--
-- Freeze the same space reach for pending invitees. Existing explicit choices
-- win; spaces created after this migration never join the snapshot.
UPDATE org_invitations i SET space_assignments = i.space_assignments || COALESCE((
  SELECT jsonb_agg(jsonb_build_object('space_id', s.id, 'preset_role', 'viewer') ORDER BY s.id)
  FROM spaces s WHERE s.org_id = i.org_id
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.space_assignments) a WHERE a->>'space_id' = s.id)
), '[]'::jsonb), role = 'guest' WHERE role = 'viewer' AND status = 'pending';

-- ═══ 4. OIDC clients that auto-provision on signup ══════════════════════════
--
-- Same freeze for the clients `0056` turned into `guest`: without a snapshot
-- they would provision a member who reaches nothing. The captured set is
-- exactly the rows whose snapshot is still empty, so a space created after this
-- runs never joins it.
UPDATE oauth_clients c SET signup_space_assignments = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('space_id', s.id, 'preset_role', 'viewer') ORDER BY s.id)
  FROM spaces s WHERE s.org_id = c.referenced_org_id
), '[]'::jsonb)
WHERE c.id IN (SELECT id FROM mig0008_oauth_clients);

-- ═══ 5. AFTER — and it must discriminate ════════════════════════════════════
--
-- "0 viewers left" is NOT a verification: a database that never had one prints
-- exactly the same number. The load-bearing check is COVERAGE — every
-- (user, space) pair captured in step 0 now has a `space_members` row — because
-- it is the only one that can tell "step 1 ran" from "step 2 erased the
-- evidence before anyone looked".
--
-- Coverage rather than a row-count delta on purpose: step 1 leaves a
-- hand-added row alone, so a viewer an admin had already granted `builder`
-- contributes to coverage and not to the delta. A delta check would abort on
-- that entirely correct state. With no viewers to begin with the captured set
-- is empty, every count is 0, and a re-run passes unchanged.
DO $$
DECLARE
  v_viewers     bigint;
  v_pending     bigint;
  v_expected    bigint;
  v_covered     bigint;
  v_uncovered   bigint;
  v_viewer_rows bigint;
  v_clients     bigint;
  v_missing_invite_assignments bigint;
  v_spaceless_clients bigint;
  v_missing_client_assignments bigint;
BEGIN
  SELECT count(*) INTO v_viewers FROM org_members WHERE role = 'viewer';
  SELECT count(*) INTO v_pending
    FROM org_invitations WHERE role = 'viewer' AND status = 'pending';
  SELECT count(*) INTO v_expected
    FROM mig0008_viewers v JOIN spaces s ON s.org_id = v.org_id;
  SELECT count(*) INTO v_covered
    FROM mig0008_viewers v
    JOIN spaces s ON s.org_id = v.org_id
    JOIN space_members m ON m.space_id = s.id AND m.user_id = v.user_id;
  v_uncovered := v_expected - v_covered;
  SELECT count(*) INTO v_viewer_rows FROM space_members WHERE preset_role = 'viewer';
  -- Post-state, not the captured set: the captured count reads the same whether
  -- step 4 wrote anything or not.
  SELECT count(*) INTO v_clients
    FROM mig0008_oauth_clients o JOIN oauth_clients c ON c.id = o.id
    WHERE c.signup_space_assignments <> '[]'::jsonb;
  SELECT count(*) INTO v_spaceless_clients
    FROM mig0008_oauth_clients o
    WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.org_id = o.referenced_org_id);

  RAISE NOTICE 'after: % org viewer(s), % pending viewer invitation(s); % of % (user, space) pair(s) covered, % total viewer space_members row(s), % legacy OAuth client(s) snapshotted, % left empty because their org has no space',
    v_viewers, v_pending, v_covered, v_expected, v_viewer_rows, v_clients, v_spaceless_clients;
  IF v_spaceless_clients <> 0 THEN
    -- Not an abort: there is nothing to snapshot. Named so the operator can
    -- decide whether such a client should keep provisioning at all.
    RAISE NOTICE 'OAuth client(s) with an empty snapshot because their org has no space: %',
      (SELECT string_agg(o.id, ', ') FROM mig0008_oauth_clients o
        WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.org_id = o.referenced_org_id));
  END IF;

  IF v_viewers <> 0 OR v_pending <> 0 THEN
    RAISE EXCEPTION 'org role viewer survives the rewrite (% member(s), % invitation(s)) — aborting', v_viewers, v_pending;
  END IF;
  IF v_uncovered <> 0 THEN
    RAISE EXCEPTION '% of % (user, space) pair(s) got no space_members row — every former viewer would silently lose the spaces they could read — aborting', v_uncovered, v_expected;
  END IF;
  SELECT count(*) INTO v_missing_invite_assignments
    FROM mig0008_invitations original
    JOIN spaces s ON s.org_id = original.org_id
    JOIN org_invitations i ON i.id = original.id
    WHERE NOT i.space_assignments @> jsonb_build_array(jsonb_build_object('space_id', s.id));
  IF v_missing_invite_assignments <> 0 THEN
    RAISE EXCEPTION '% pending invitation space assignment(s) missing — aborting', v_missing_invite_assignments;
  END IF;
  SELECT count(*) INTO v_missing_client_assignments
    FROM mig0008_oauth_clients original
    JOIN spaces s ON s.org_id = original.referenced_org_id
    JOIN oauth_clients c ON c.id = original.id
    WHERE NOT c.signup_space_assignments @> jsonb_build_array(jsonb_build_object('space_id', s.id));
  IF v_missing_client_assignments <> 0 THEN
    RAISE EXCEPTION '% OAuth signup space assignment(s) missing — those clients would provision a guest who reaches nothing — aborting', v_missing_client_assignments;
  END IF;
END $$;

-- ═══ 6. Close the window ════════════════════════════════════════════════════
--
-- Reached only when step 5 accepted the result: an abort rolls this back with
-- everything else, so a failed run stays re-runnable in full. Written even when
-- there was nothing to move — the point of the marker is that the window is
-- over, not that rows changed.
INSERT INTO drizzle.migration_scripts (script) VALUES ('0008-org-viewer-to-guest')
ON CONFLICT (script) DO NOTHING;

COMMIT;
