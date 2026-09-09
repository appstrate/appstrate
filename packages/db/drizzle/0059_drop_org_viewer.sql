-- Narrow `org_role` to the four values the code declares — `ORG_ROLES` in
-- `packages/core/src/permissions.ts`, which is literally the tuple
-- `packages/db/src/schema/enums.ts` hands to `pgEnum` — by removing the fifth
-- one, `viewer`, that `0056_space_roles.sql` had to leave behind.
--
-- `ALTER TYPE … DROP VALUE` exists in no released PostgreSQL, so an enum is
-- narrowed the only way it can be: a second type is built, every column moves
-- onto it, and the old type is dropped. That is the whole of section B. There
-- is no data write in this file (`docs/NO_TRANSITIONAL_CODE.md` §2) — the rows
-- move in `scripts/migration/0008` and `scripts/migration/0012`, and section A
-- refuses to run until they have.
--
-- ═══ WHETHER THIS MAY SHIP WITH `0056` DEPENDS ON THE DATABASE ═══
--
-- Drizzle applies the whole pending batch in ONE transaction, and the row
-- scripts run between the batch and the new application starting — so nothing
-- can run BETWEEN `0056` and this file within one release. Two cases follow,
-- and section A's counts are what tell them apart:
--
--   * the database HAS `viewer` rows. `0008` has to read them to compute the
--     `space_members` rows that preserve their reach, and it cannot run until
--     `0056` has created that table — so it is sandwiched between two
--     migrations, and the sandwich needs two releases: `0056` + `0008` + `0012`
--     in one, this file in the next. Section A fails the deploy if that order
--     is not respected.
--   * the database has NONE — never had a `viewer`, or an operator moved the
--     rows off the value before the window. Then `0008` and `0012` have nothing
--     to do, section A reads four zeros, and `0056` + `0057` + this file apply
--     as one ordinary batch. The pre-flight in `scripts/migration/README.md`
--     step 3 is the query that decides.
--
-- That constraint is what section A exists to enforce. It is not a retirement
-- guard in the sense of `NO_TRANSITIONAL_CODE.md` §4 — deleting it does not
-- make a premature deploy succeed, it makes it fail as a bare
-- `22P02 invalid input value for enum org_role: "viewer"` raised by section B's
-- own cast, with nothing on screen to say which script clears it. Section A
-- buys the message, not the safety.
--
-- ═══ WHY THE COMPARISONS ARE `::text` ═══
--
-- `role = 'viewer'` is the natural spelling and it is wrong here. Once this
-- migration has run, `'viewer'` no longer parses as an `org_role`, so the
-- literal raises `22P02` — on a CONVERGED database, from the guard whose job is
-- to be a no-op there. `role::text = 'viewer'` compares strings and returns 0.
--
-- ═══ WHAT DEPENDS ON THE TYPE ═══
--
-- Two columns, both moved below: `org_members.role` and `org_invitations.role`.
-- Neither carries a DEFAULT (`0000_init.sql`), which is what would otherwise
-- make `ALTER COLUMN … TYPE` refuse the cast. `oauth_clients.signup_role` is
-- `text` with a CHECK, not this enum, and is read by section A only because a
-- `viewer` left there means the RBAC window did not complete.
--
-- Anything else that ends up depending on the old type — a column added by an
-- out-of-tree module, a view, a function signature — stops the `DROP TYPE` at
-- the end of section B with Postgres' own list of dependent objects, and the
-- batch rolls back. That is the intended outcome: this file knows two columns,
-- and a third one is a decision, not something to silently rewrite.
--
-- ROLLBACK: one-way, like `0056`. Restoring the previous build's wider type is
-- mechanical — but whatever moved the rows off `viewer` ran before this file,
-- and that is the step there is no way back from: `0008` folds them into
-- `guest` plus space rows, and an operator who cleared them by hand chose some
-- other value. Neither is recoverable from the enum. Roll forward.
--
-- FENCES, same instrument as 0039/0047/0055/0056. `lock_timeout` bounds
-- acquisition, `statement_timeout` bounds execution; neither bounds the hold,
-- which lasts until drizzle commits the batch. Section B takes ACCESS EXCLUSIVE
-- on both tables and rewrites them — they hold one row per membership and one
-- per invitation, so this is a sub-second rewrite on any real installation, and
-- on expiry the statement errors, the batch aborts and boot fails its health
-- gate: a failed deploy, not a silent skip.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

-- ═══ A. The rows must already have moved ═════════════════════════════════════
--
-- Four counts, three owners, and each count is printed separately because a
-- different file clears it and the operator needs to know which:
--
--   * org members and PENDING invitations → `0008-org-viewer-to-guest.sql`,
--     which also writes the `space_members` rows that preserve their reach;
--   * every other invitation (accepted, expired, cancelled) →
--     `0012-org-invitation-history-viewer-to-guest.sql`. `0008` deliberately
--     leaves these alone: a non-pending invitation grants nothing, so it needs
--     no space snapshot, and widening `0008`'s WHERE would have made it flip
--     rows it could not account for in its coverage check;
--   * OAuth signup clients → `0056` itself flipped these (its section G), which
--     is what let it narrow `oauth_clients_signup_role_check`. A row still
--     reading `viewer` here means that CHECK is not on the table, i.e. `0056`
--     never ran on this database.
DO $$
DECLARE
  v_members  bigint;
  v_pending  bigint;
  v_history  bigint;
  v_clients  bigint;
BEGIN
  SELECT count(*) INTO v_members
    FROM org_members WHERE role::text = 'viewer';
  SELECT count(*) INTO v_pending
    FROM org_invitations WHERE role::text = 'viewer' AND status = 'pending';
  SELECT count(*) INTO v_history
    FROM org_invitations WHERE role::text = 'viewer' AND status <> 'pending';
  SELECT count(*) INTO v_clients
    FROM oauth_clients WHERE signup_role = 'viewer';

  IF v_members + v_pending + v_history + v_clients > 0 THEN
    -- The remedy goes in the MESSAGE, not in a `HINT`: a client that surfaces
    -- only `error.message` (drizzle's, PGlite's, and every log line the deploy
    -- writes) would drop a hint silently, leaving the operator the counts and
    -- no instruction.
    --
    -- All four counts are reported in ONE pass, and that is the guard's whole
    -- product. Section B casts one table per statement and aborts on the first,
    -- so without this an operator clears `org_members`, redeploys, meets the
    -- same opaque `22P02` for `org_invitations`, and redeploys again — a
    -- serialised loop of container restarts inside a stopped-traffic window.
    --
    -- The two scripts clear THREE of the four. `v_clients` is the exception and
    -- says so in its own clause: neither script writes `oauth_clients`
    -- (`0008` only reads `signup_role = 'guest'`, `0012` touches
    -- `org_invitations` alone), because the row that count refers to is
    -- `0056`'s to flip. Routing it to them would send the operator round the
    -- loop this message exists to prevent. Same shape as `0021`'s
    -- "migration 0020 did not apply. Check the `__drizzle_migrations`
    -- watermark before retrying."
    RAISE EXCEPTION
      'org_role still carries % viewer member(s), % pending viewer invitation(s), % historical viewer invitation(s) and % viewer signup client(s). For the first three: run scripts/migration/0008-org-viewer-to-guest.sql and scripts/migration/0012-org-invitation-history-viewer-to-guest.sql, then redeploy. A non-zero signup client count is cleared by NEITHER script — it means 0056_space_roles.sql did not apply on this database; check the drizzle.__drizzle_migrations watermark before retrying.',
      v_members, v_pending, v_history, v_clients;
  END IF;
END $$;--> statement-breakpoint

-- ═══ B. Rebuild the type without `viewer` ════════════════════════════════════
--
-- Guarded on the label itself rather than on a step of its own, so the file
-- converges from either end: with `viewer` present it does the whole swap, and
-- with it already gone — a rerun, or a database some operator narrowed by hand
-- — it returns without touching anything. The four statements in between are
-- not individually idempotent and do not need to be: drizzle runs the batch in
-- one transaction, so they either all land or none do.
--
-- ORDER: rename, create, move, drop. Creating the new type under the FINAL name
-- rather than a temporary one is what keeps `packages/db/src/schema` honest —
-- the type the columns end up on is spelled `org_role`, the name drizzle's
-- snapshot and every later migration address it by. The old type is the one
-- wearing the temporary name, and it survives only until the last column has
-- left it.
--
-- `USING "role"::text::org_role` casts through `text` because Postgres offers no
-- direct cast between two enum types. The target is spelled unqualified there
-- while the `TYPE` clause beside it is qualified, and both resolve to the type
-- created two lines above: `search_path` is `public` for the whole batch, and
-- `scripts/verify-no-migration-dml.ts` reads a `USING` expression as a pure
-- CONVERSION — not a row rewrite — only in that spelling. A repair written in
-- that position is a write it is meant to catch, and this is not one: every
-- value goes through unchanged. Every surviving value — `owner`, `admin`,
-- `member`, `guest` — is a label of both types, so the cast is total; `viewer`
-- is the one that is not, and section A has already established there is none.
-- Using the new type inside the same transaction that created it is explicitly
-- safe (Postgres' `check_safe_enum_use` blocks a value added to a PRE-EXISTING
-- type by `ALTER TYPE … ADD VALUE`, which is `0056`'s case, not this one).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'org_role' AND e.enumlabel = 'viewer'
  ) THEN
    RETURN;
  END IF;

  ALTER TYPE "public"."org_role" RENAME TO "org_role__pre_0059";
  CREATE TYPE "public"."org_role" AS ENUM ('owner', 'admin', 'member', 'guest');

  ALTER TABLE "org_members"
    ALTER COLUMN "role" TYPE "public"."org_role" USING "role"::text::org_role;
  ALTER TABLE "org_invitations"
    ALTER COLUMN "role" TYPE "public"."org_role" USING "role"::text::org_role;

  DROP TYPE "public"."org_role__pre_0059";
END $$;
