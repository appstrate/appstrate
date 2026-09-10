-- Admit the fifth space-role preset, `runner` (`SPACE_ROLE_PRESETS` in
-- `packages/core/src/permissions.ts`), in the three CHECKs of
-- `packages/db/src/schema/spaces.ts` that spell the preset names out by hand.
--
-- WHY. A `runner` launches agents it may not read: `agents:run` without
-- `agents:read`, its own runs without `runs:read-all`, no `skills:read` and no
-- `:write` anywhere. The preset is a code constant like the other four
-- (RBAC spec §3.3) — the only thing the database has to know about it is that
-- the string is legal in `spaces.default_role` and `space_members.preset_role`,
-- and RESERVED in `space_roles.key` — the third constraint, which backs
-- `assertNotPresetKey` (`apps/api/src/services/space-roles.ts`) so a custom
-- bundle can never be keyed after a preset and shadow it in the role catalog.
--
-- SHAPE ONLY. No row is written (`docs/NO_TRANSITIONAL_CODE.md` §2). For the
-- first two the value is new, so no existing row can carry it and every row
-- that satisfied the old predicate satisfies the wider one. `ADD CONSTRAINT`
-- still scans each table to validate — one row per space, one per membership,
-- one per custom bundle, so the scan is sub-second on any real installation and
-- `NOT VALID` + a later `VALIDATE` would buy nothing at that size.
--
-- THE THIRD ONE NARROWS, and a database can already hold a row it refuses: an
-- organization that defined a custom role keyed `runner` before the preset
-- existed. Section A counts those first, because the bare constraint violation
-- names the constraint and not the remedy, and the remedy is a rename an
-- operator has to choose (the key is what the role is addressed by; nothing
-- here can pick a new one). Custom roles are EE-gated, so on an OSS install
-- this count is structurally zero.
--
-- DROP-then-ADD because a CHECK cannot be edited in place. `IF EXISTS` on each
-- DROP is what makes the file converge from either end — a rerun, or an install
-- an operator repaired by hand — and every statement runs inside drizzle's
-- single batch transaction, so there is no window in which any of the three
-- tables is unconstrained.
--
-- ROLLBACK: one-way in practice. A previous build re-narrows the predicate, and
-- its ADD then fails on any row assigned `runner` in the meantime — a loud
-- refusal, not a silent downgrade to some other preset. Roll forward.

-- ═══ A. No custom role may already be keyed after the new preset ═══════════
DO $$
DECLARE
  v_roles bigint;
BEGIN
  SELECT count(*) INTO v_roles FROM space_roles WHERE key = 'runner';
  IF v_roles > 0 THEN
    -- The remedy goes in the MESSAGE, not a HINT: drizzle, PGlite and every
    -- deploy log line surface `error.message` alone.
    RAISE EXCEPTION
      'space_roles holds % custom role(s) keyed ''runner'', which is now a built-in preset. Rename them (UPDATE space_roles SET key = ... WHERE key = ''runner''), then redeploy.',
      v_roles;
  END IF;
END $$;--> statement-breakpoint

-- ═══ B. The three predicates ═══════════════════════════════════════════════
ALTER TABLE "spaces" DROP CONSTRAINT IF EXISTS "spaces_default_role_valid";--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_default_role_valid" CHECK (default_role IN ('admin', 'builder', 'operator', 'runner', 'viewer'));--> statement-breakpoint
ALTER TABLE "space_members" DROP CONSTRAINT IF EXISTS "space_members_preset_valid";--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_preset_valid" CHECK (preset_role IS NULL OR preset_role IN ('admin', 'builder', 'operator', 'runner', 'viewer'));--> statement-breakpoint
ALTER TABLE "space_roles" DROP CONSTRAINT IF EXISTS "space_roles_key_not_preset";--> statement-breakpoint
ALTER TABLE "space_roles" ADD CONSTRAINT "space_roles_key_not_preset" CHECK (key NOT IN ('admin', 'builder', 'operator', 'runner', 'viewer'));
