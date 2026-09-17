-- 0017 — the two org members who were moved off `viewer` BY HAND, given the
-- `guest` + explicit-space-rows shape `0008` would have given them.
--
-- Run INSIDE the window, right after `0008` and `0012`, before the new
-- application starts. It is the third file of the same repair, not a follow-up:
-- `scripts/migration/README.md` → "Release beta.58", step 4.
--
-- ═══ WHAT IT REPAIRS ═══
--
-- On 2026-09-09 production held 2 org members reading `viewer`, in 2
-- organizations of one space each, and they were moved off the value by hand so
-- the whole RBAC rollout could ship as one release (README Log, `0008`). At
-- that moment `guest` did not exist in the `org_role` type — it is
-- `packages/db/drizzle/0056_space_roles.sql` section A that adds it, and `0056`
-- has never applied on production — so `member` was the only value available.
--
-- `member` is STRICTLY WIDER than what those two accounts had. `0056` also sets
-- `spaces.default_role`, and an open space's default is `operator`: from the
-- first boot of the new build, a `member` holds WRITE in every open space of
-- their organization, which a `viewer` never did. The hand move was correct as
-- an unblocking act and wrong as an end state, and nothing else catches it —
-- `0008` selects `WHERE role::text = 'viewer'`, which is now the empty set, so
-- it runs green over these two rows and leaves them exactly as they are.
--
-- ═══ WHAT IT DOES ═══
--
-- The same two writes `0008` performs for a real `viewer`, in the same order:
--
--   1. one `space_members` row with `preset_role = 'viewer'` per TEAM space of
--      their organization — without it a `guest` reaches nothing at all
--      (RBAC spec §11, decision 6);
--   2. the org role itself, `member` → `guest`.
--
-- Rows first, role second, so there is no instant at which the account is a
-- `guest` with no reach — academic inside one transaction, and the shape stays
-- the same as `0008`'s for a reader comparing the two.
--
-- TEAM spaces only: `spaces.owner_user_id IS NULL` (`0064`). A personal space
-- belongs to the one member it names and takes no membership row; none exists
-- yet at this point in the window — `0015` has not run and the application has
-- not started — but the predicate is the correct one, not a convenience.
--
-- ═══ WHAT IT REFUSES ═══
--
-- It touches a row ONLY while that row still reads `member`
-- (`AND role::text = 'member'`, captured in step 0). A pair somebody has since
-- promoted to `admin`, demoted to `guest` by hand, or removed from the
-- organization is left alone and NAMED in a notice — a decision taken after
-- 2026-09-09 outranks this file, and silently overwriting it would be the one
-- unrecoverable thing here.
--
-- It also ABORTS the transaction when a captured pair did not end up `guest`,
-- or when any (captured member, team space) pair got no `space_members` row.
-- Coverage is the discriminating half, for `0008`'s reason: "0 members left"
-- is also what a database prints when the capture was empty and nothing ran.
--
-- Two mis-orderings fail loudly rather than quietly, and neither needs a guard
-- of its own: run before `0064` and `spaces.owner_user_id` does not exist
-- (`42703`); run before `0056` and the literal `'guest'` does not parse as an
-- `org_role` (`22P02`). Both abort the transaction and name the missing object.
--
-- ═══ WHY THE COMPARISONS ARE `::text` ═══
--
-- Same reason as `0008` and `0012`, and the authority is the same:
-- `0059_drop_org_viewer.sql` → "WHY THE COMPARISONS ARE `::text`". By the time
-- this file runs the batch has taken `0059`, so `org_role` no longer carries
-- `viewer` — and a bare literal is CAST before it is compared, so even a
-- predicate over zero rows raises `22P02`. `member` is still a label of the
-- type and would compare fine unquoted; it is spelled `::text` anyway, so that
-- every `org_role` predicate in this directory reads the same way and none of
-- them becomes a trap when the vocabulary next moves.
--
-- ═══ IDEMPOTENT, AND WITHOUT A RUN-ONCE MARKER ═══
--
-- Deliberately no row in `drizzle.migration_scripts`. That marker exists in
-- `0008` for one reason — its step 4 predicate
-- (`signup_role = 'guest' AND signup_space_assignments = '[]'::jsonb`) is
-- PERMANENT, so a later run would re-match rows nobody meant to touch and widen
-- them onto every space created since. Nothing here has that shape: every write
-- is driven by the step-0 capture, whose predicate is exactly the condition
-- step 3 removes. On a second pass the capture is EMPTY — those rows read
-- `guest` — so the insert writes nothing, the update matches nothing, and the
-- coverage checks pass over an empty set. `0016` carries no marker for the same
-- reason (README, "Writing one", requirement 1).
--
-- One transaction, fenced. One `INSERT` (`ON CONFLICT DO NOTHING`), one
-- `UPDATE`, no `DELETE`.
--
-- Rows: the two pairs below were COUNTED on production read-only (2026-09-17:
-- `org_members` holds 31 `owner`, 16 `admin`, 2 `member`, 0 `viewer`; the 2
-- `member` rows are these accounts). NOT rehearsed against a restored dump —
-- do that first, per README requirement 4, and record the before/after counts
-- the script prints.
--
--   -- Standalone re-check, after the fact — both must read `guest`, and each
--   -- must hold one `viewer` row per team space of its organization:
--   SELECT m.org_id, m.user_id, m.role::text AS org_role,
--          (SELECT count(*) FROM spaces s
--             WHERE s.org_id = m.org_id AND s.owner_user_id IS NULL) AS team_spaces,
--          (SELECT count(*) FROM space_members sm
--             JOIN spaces s ON s.id = sm.space_id
--            WHERE s.org_id = m.org_id AND s.owner_user_id IS NULL
--              AND sm.user_id = m.user_id
--              AND sm.preset_role = 'viewer')                         AS viewer_rows
--   FROM org_members m
--   WHERE (m.org_id, m.user_id) IN (
--     ('48b0854c-6f42-406c-a3c7-bbdd285a0355', 'GlaICg7JIo1yAVuc9TzCzBZ7kUMpjU4i'),
--     ('e569c4fb-1721-4406-8cfd-9b362ecf7043', 'bSPoyUV0lTPO77jcsGODhQ3cAFclTKXV')
--   );
--
-- ROLLBACK: reversible, unlike `0056` and `0064`. Put the two rows back where
-- the hand move left them and drop the grants this file wrote:
--
--   UPDATE org_members SET role = 'member'
--    WHERE (org_id, user_id) IN (('48b0854c-…', 'GlaICg7…'), ('e569c4fb-…', 'bSPoyUV…'));
--   DELETE FROM space_members sm USING spaces s
--    WHERE s.id = sm.space_id AND sm.preset_role = 'viewer'
--      AND (s.org_id, sm.user_id) IN (('48b0854c-…', 'GlaICg7…'), ('e569c4fb-…', 'bSPoyUV…'));
--
-- Only do that knowing what it restores: `member` + `spaces.default_role =
-- 'operator'` is write access in every open space of those organizations.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ═══ 0. The two pairs, and the subset this file may still touch ═════════════
--
-- Spelled out as literals rather than derived from a predicate: "the accounts
-- moved by hand on 2026-09-09" is a fact about one afternoon, not a queryable
-- property. `role::text = 'member'` cannot recover it either — it would also
-- match every legitimate member of every organization.
--
-- `ON COMMIT DROP`: the tables live exactly as long as this transaction, so a
-- failed run leaves nothing behind and a re-run starts clean.
-- `org_id` is `uuid` (`org_members`, `spaces`) and `user_id` is `text`
-- (Better Auth ids). Declared with the real types so every join below is a
-- native comparison — a `text` column here would fail with
-- `operator does not exist: uuid = text` on the first join.
CREATE TEMP TABLE mig0017_handmoved (org_id uuid, user_id text) ON COMMIT DROP;
INSERT INTO mig0017_handmoved (org_id, user_id) VALUES
  -- org "TANIÈRE", 1 space: spc_64049294-dbfb-49e9-bdcf-6fa321869fd2
  ('48b0854c-6f42-406c-a3c7-bbdd285a0355', 'GlaICg7JIo1yAVuc9TzCzBZ7kUMpjU4i'),
  -- org "Le Jardin Intérieur", 1 space: spc_14881e0c-d009-400e-99e0-7962178f5051
  ('e569c4fb-1721-4406-8cfd-9b362ecf7043', 'bSPoyUV0lTPO77jcsGODhQ3cAFclTKXV');

-- The capture is what makes every write below converge, and what step 4 checks
-- itself against: only a pair that STILL reads `member` is in scope.
CREATE TEMP TABLE mig0017_targets ON COMMIT DROP AS
  SELECT m.org_id, m.user_id
  FROM mig0017_handmoved h
  JOIN org_members m ON m.org_id = h.org_id AND m.user_id = h.user_id
  WHERE m.role::text = 'member';

-- ═══ 1. BEFORE — and it must DISCRIMINATE ═══════════════════════════════════
--
-- Every pair is reported with the role it actually holds, so "nothing to do"
-- and "somebody changed this" read differently. A pair that is not a member of
-- the organization at all is named too, rather than vanishing into a count.
DO $$
DECLARE
  v_handmoved bigint;
  v_targets   bigint;
  v_expected  bigint;
  v_existing  bigint;
  v_roles     text;
  v_absent    text;
BEGIN
  SELECT count(*) INTO v_handmoved FROM mig0017_handmoved;
  SELECT count(*) INTO v_targets   FROM mig0017_targets;
  -- The target x team-space product: the pairs that must carry a
  -- `space_members` row once step 2 has run.
  SELECT count(*) INTO v_expected
    FROM mig0017_targets t
    JOIN spaces s ON s.org_id = t.org_id AND s.owner_user_id IS NULL;
  -- Rows an admin already granted by hand. Step 2 leaves those alone
  -- (`ON CONFLICT DO NOTHING`), so they count towards coverage and not towards
  -- the delta — which is why step 4 checks coverage and not the delta.
  SELECT count(*) INTO v_existing
    FROM mig0017_targets t
    JOIN spaces s ON s.org_id = t.org_id AND s.owner_user_id IS NULL
    JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = t.user_id;

  SELECT string_agg(h.org_id::text || '/' || h.user_id || ' = ' || COALESCE(m.role::text, 'NOT A MEMBER'),
                    ', ' ORDER BY h.org_id)
    INTO v_roles
    FROM mig0017_handmoved h
    LEFT JOIN org_members m ON m.org_id = h.org_id AND m.user_id = h.user_id;

  RAISE NOTICE 'before: % hand-moved pair(s) on file, % still reading member, % (user, team space) pair(s) to cover, % already covered by a hand-added row',
    v_handmoved, v_targets, v_expected, v_existing;
  RAISE NOTICE 'before: current org role of each pair — %', v_roles;

  SELECT string_agg(h.org_id::text || '/' || h.user_id, ', ' ORDER BY h.org_id)
    INTO v_absent
    FROM mig0017_handmoved h
    WHERE NOT EXISTS (
      SELECT 1 FROM org_members m
      WHERE m.org_id = h.org_id AND m.user_id = h.user_id
    );
  IF v_absent IS NOT NULL THEN
    -- Not an abort: a membership that no longer exists needs no repair, and
    -- this file has no business recreating one.
    RAISE NOTICE 'pair(s) no longer a member of their organization, left alone: %', v_absent;
  END IF;
END $$;

-- ═══ 2. The reach, before the role ══════════════════════════════════════════
--
-- Exactly what `0008` step 1 writes for a real `viewer`, over the team spaces
-- that exist NOW. A space created after this runs gets no row, which is the
-- point of the split: `guest` + explicit rows reproduces the old reach and does
-- not widen onto anything later.
--
-- `added_by` is left NULL — nobody granted these; they are a repair, and the
-- audit trail carries no event for them, the same choice `0016` makes for
-- `package_shares.shared_by`.
INSERT INTO space_members (space_id, user_id, preset_role)
SELECT s.id, t.user_id, 'viewer'
FROM mig0017_targets t
JOIN spaces s ON s.org_id = t.org_id AND s.owner_user_id IS NULL
ON CONFLICT (space_id, user_id) DO NOTHING;

-- ═══ 3. The org role itself ═════════════════════════════════════════════════
--
-- The `role::text = 'member'` is redundant with the capture and kept anyway: it
-- is what makes the statement readable on its own as "only while it is still a
-- member", which is the whole refusal this file promises.
UPDATE org_members m
SET role = 'guest'
FROM mig0017_targets t
WHERE m.org_id = t.org_id
  AND m.user_id = t.user_id
  AND m.role::text = 'member';

-- ═══ 4. AFTER — and it must DISCRIMINATE ════════════════════════════════════
--
-- Coverage over the CAPTURED set is the load-bearing check, for `0008`'s
-- reason: once step 3 has run there is no way left to ask "who was a member",
-- so a check written against the post-state alone would degrade to "0 members
-- left" — which a database that never had these rows prints too. With an empty
-- capture every count is 0 and a re-run passes unchanged.
DO $$
DECLARE
  v_targets     bigint;
  v_still       bigint;
  v_expected    bigint;
  v_covered     bigint;
  v_uncovered   bigint;
  v_roles       text;
BEGIN
  SELECT count(*) INTO v_targets FROM mig0017_targets;
  SELECT count(*) INTO v_still
    FROM mig0017_targets t
    JOIN org_members m ON m.org_id = t.org_id AND m.user_id = t.user_id
    WHERE m.role::text = 'member';
  SELECT count(*) INTO v_expected
    FROM mig0017_targets t
    JOIN spaces s ON s.org_id = t.org_id AND s.owner_user_id IS NULL;
  SELECT count(*) INTO v_covered
    FROM mig0017_targets t
    JOIN spaces s ON s.org_id = t.org_id AND s.owner_user_id IS NULL
    JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = t.user_id;
  v_uncovered := v_expected - v_covered;

  SELECT string_agg(h.org_id::text || '/' || h.user_id || ' = ' || COALESCE(m.role::text, 'NOT A MEMBER'),
                    ', ' ORDER BY h.org_id)
    INTO v_roles
    FROM mig0017_handmoved h
    LEFT JOIN org_members m ON m.org_id = h.org_id AND m.user_id = h.user_id;

  RAISE NOTICE 'after: % pair(s) moved, % still reading member, % of % (user, team space) pair(s) covered',
    v_targets, v_still, v_covered, v_expected;
  RAISE NOTICE 'after: org role of each pair — %', v_roles;

  IF v_still <> 0 THEN
    RAISE EXCEPTION '% captured pair(s) still read member after the update — aborting', v_still;
  END IF;
  IF v_uncovered <> 0 THEN
    RAISE EXCEPTION '% of % (user, team space) pair(s) got no space_members row — those accounts would become a guest that reaches nothing — aborting',
      v_uncovered, v_expected;
  END IF;
END $$;

COMMIT;
