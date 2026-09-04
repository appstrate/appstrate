-- 0008 — retire the org role `viewer`, and give every chat session a space.
--
-- Run AFTER `packages/db/drizzle/0056_space_roles.sql` (which adds `guest` to
-- the `org_role` type, creates `space_members`, and adds
-- `chat_sessions.space_id`) and BEFORE bringing the new application version up.
-- Between those two points a `viewer` cannot log in: the code refuses the value
-- loudly (`UnmigratedOrgRoleError`, `apps/api/src/lib/permissions.ts`) rather
-- than mapping it to `guest` behind the operator's back.
--
-- Why the rewrite is `guest` + explicit rows and not simply `member`:
-- read-only-everywhere is a SPACE concern now. `guest` alone would take those
-- users' access away; `member` alone would GIVE them the open spaces' default
-- preset, which is `operator` — write access they never had. `guest` plus a
-- `viewer` row in every space that exists today reproduces their reach exactly,
-- and does not widen onto spaces created later. RBAC spec §11, decision 6.
--
-- Idempotent: every WHERE is exactly the condition it removes, so a second run
-- matches zero rows. Steps 1 and 4 additionally use `ON CONFLICT DO NOTHING` /
-- `IS NULL`, so a partially-applied database converges.
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
-- The script prints them itself, before and after, in one transaction. Three
-- numbers, and all three must move together — a query that returns 0 whether
-- the work happened or not proves nothing (`verification-must-discriminate`):
--
--   before: V viewers, S spaces reachable by them, C null-space chat sessions
--   after:  0 viewers, 0 null-space chat sessions, and EXACTLY the
--           viewer×space product inserted into `space_members`
--
-- Coverage is the discriminating half: "0 viewers left" alone is also what a
-- database with no viewers to begin with prints, and would hide a step 1 that
-- inserted nothing before step 2 erased the evidence. The script carries the
-- pre-flip viewer set in a temp table so step 5 can check every (user, space)
-- pair it owed a row, and ABORTS the whole transaction when one is missing.
--
--   -- Standalone re-check, after the fact:
--   SELECT
--     (SELECT count(*) FROM org_members     WHERE role = 'viewer')                AS viewers_left,
--     (SELECT count(*) FROM org_invitations WHERE role = 'viewer'
--                                             AND status = 'pending')             AS pending_left,
--     (SELECT count(*) FROM oauth_clients   WHERE signup_role = 'viewer')         AS signup_left,
--     (SELECT count(*) FROM chat_sessions   WHERE space_id IS NULL)               AS sessions_left,
--     (SELECT count(*) FROM space_members   WHERE preset_role = 'viewer')         AS viewer_rows;
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '300s';

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

DO $$
DECLARE
  v_viewers    bigint;
  v_expected   bigint;
  v_existing   bigint;
  v_pending    bigint;
  v_signup     bigint;
  v_sessions   bigint;
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
  SELECT count(*) INTO v_signup FROM oauth_clients WHERE signup_role = 'viewer';
  SELECT count(*) INTO v_sessions FROM chat_sessions WHERE space_id IS NULL;
  RAISE NOTICE 'before: % org viewer(s), % (user, space) pair(s) to cover, % already covered by a hand-added row, % pending viewer invitation(s), % oauth client(s) auto-provisioning viewer, % chat session(s) without a space',
    v_viewers, v_expected, v_existing, v_pending, v_signup, v_sessions;
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
-- A pending viewer invite lands as a guest with NO space, because there is no
-- faithful mapping: the invitee has no membership rows to carry over and
-- guessing a set of spaces for them is worse than nothing. The inviter re-adds
-- them; the audit log names the inviter.
UPDATE org_invitations SET role = 'guest' WHERE role = 'viewer' AND status = 'pending';

-- ═══ 3b. OIDC auto-provisioning ═════════════════════════════════════════════
--
-- NOT one of the five steps in the spec, and deliberately added: an
-- `oauth_clients.signup_role` of `viewer` writes that value straight into
-- `org_members.role` on the next SSO signup, which would re-create exactly the
-- rows step 2 just removed — and the new code refuses it, so the client's
-- signups would 500 forever. Same rewrite, same reasoning.
UPDATE oauth_clients SET signup_role = 'guest' WHERE signup_role = 'viewer';

-- ═══ 4. Chat sessions get their org's default space ═════════════════════════
--
-- `space_id` is nullable for exactly this window; `0057` promotes it to
-- NOT NULL once this has run everywhere.
UPDATE chat_sessions c
SET space_id = s.id
FROM spaces s
WHERE s.org_id = c.org_id AND s.is_default AND c.space_id IS NULL;

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
  v_signup      bigint;
  v_sessions    bigint;
  v_expected    bigint;
  v_covered     bigint;
  v_uncovered   bigint;
  v_viewer_rows bigint;
BEGIN
  SELECT count(*) INTO v_viewers FROM org_members WHERE role = 'viewer';
  SELECT count(*) INTO v_pending
    FROM org_invitations WHERE role = 'viewer' AND status = 'pending';
  SELECT count(*) INTO v_signup FROM oauth_clients WHERE signup_role = 'viewer';
  SELECT count(*) INTO v_sessions FROM chat_sessions WHERE space_id IS NULL;
  SELECT count(*) INTO v_expected
    FROM mig0008_viewers v JOIN spaces s ON s.org_id = v.org_id;
  SELECT count(*) INTO v_covered
    FROM mig0008_viewers v
    JOIN spaces s ON s.org_id = v.org_id
    JOIN space_members m ON m.space_id = s.id AND m.user_id = v.user_id;
  v_uncovered := v_expected - v_covered;
  SELECT count(*) INTO v_viewer_rows FROM space_members WHERE preset_role = 'viewer';

  RAISE NOTICE 'after: % org viewer(s), % pending viewer invitation(s), % oauth client(s) auto-provisioning viewer, % chat session(s) without a space; % of % (user, space) pair(s) covered, % total viewer space_members row(s)',
    v_viewers, v_pending, v_signup, v_sessions, v_covered, v_expected, v_viewer_rows;

  IF v_viewers <> 0 OR v_pending <> 0 OR v_signup <> 0 THEN
    RAISE EXCEPTION 'org role viewer survives the rewrite (% member(s), % invitation(s), % oauth client(s)) — aborting', v_viewers, v_pending, v_signup;
  END IF;
  IF v_uncovered <> 0 THEN
    RAISE EXCEPTION '% of % (user, space) pair(s) got no space_members row — every former viewer would silently lose the spaces they could read — aborting', v_uncovered, v_expected;
  END IF;
  IF v_sessions <> 0 THEN
    RAISE EXCEPTION '% chat session(s) still have no space — an org without a default space? — aborting', v_sessions;
  END IF;
END $$;

COMMIT;
