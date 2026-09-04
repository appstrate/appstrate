-- Space membership becomes a data model (RBAC spec §5). Everything here is
-- ADDITIVE: a new enum value, two new tables, four new columns. No column is
-- dropped, no constraint is tightened, no row is touched.
--
-- WHAT THIS RELEASE DOES NOT DO, AND WHY:
--
--   * `org_role` keeps its `viewer` value. `ALTER TYPE … DROP VALUE` does not
--     exist in Postgres; retiring a value means recreating the type, which is
--     `0057` in the NEXT release, guarded on `scripts/migration/0008` having
--     run. Until then the type accepts a value the application refuses —
--     `assertOrgRole` (`apps/api/src/lib/permissions.ts`) throws
--     `UnmigratedOrgRoleError` naming that script rather than mapping the row
--     to `guest`, which would silently change what those users reach.
--   * `chat_sessions.space_id` is NULLABLE. `0008` backfills it; `0057`
--     promotes it. A NULL is refused by the chat module, never defaulted.
--   * `oauth_clients_signup_role_check` is WIDENED, not replaced: `guest` is
--     added beside `viewer` so a database that has not run `0008` still holds
--     its rows. `0057` narrows it.
--
-- ROLLBACK POSTURE: safe. The previous application version reads none of these
-- columns and writes none of these tables, so redeploying it after this ran
-- leaves the additions inert. That is the whole reason the retirement half is
-- a separate release.
--
-- ORDER: `ALTER TYPE … ADD VALUE` first and used by nothing in this file.
-- Postgres ≥12 allows it inside a transaction block (drizzle wraps the pending
-- batch in one) provided the new value is not USED in the same transaction —
-- no statement below mentions `guest`, and there is no DML here at all.
--
-- FENCES, set once for the whole file, same instrument as 0039/0047/0055.
-- `lock_timeout` bounds acquisition, `statement_timeout` bounds execution;
-- neither bounds the hold, which lasts until drizzle commits the batch. Every
-- statement below is catalog-only or a create-on-empty-table, so the work is
-- instant and the exposure is acquisition. On expiry the statement errors, the
-- batch aborts, boot fails its health gate — a failed deploy, not a silent skip.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

-- ═══ A. `guest` joins the org-role vocabulary ════════════════════════════════
--
-- `IF NOT EXISTS` so a partially-applied environment converges (0041's
-- reasoning): the value already being present IS the intended end state.
ALTER TYPE "public"."org_role" ADD VALUE IF NOT EXISTS 'guest';--> statement-breakpoint

-- ═══ B. Spaces gain a visibility and a default role ══════════════════════════
--
-- Both are `text` + CHECK rather than pg enums, the same choice `webhooks.level`
-- made: adding a value is a migration either way and text spares the enum
-- rewrite. Both carry a DEFAULT, so every existing row is `open` / `operator`
-- — today's behaviour exactly (every member reaches every space, with the
-- operator slice), which is what makes this release a no-op for live installs.
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "default_role" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spaces_visibility_valid'
      AND conrelid = 'public.spaces'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "spaces" ADD CONSTRAINT "spaces_visibility_valid" CHECK (visibility IN ('open', 'closed', 'private'));
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spaces_default_role_valid'
      AND conrelid = 'public.spaces'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "spaces" ADD CONSTRAINT "spaces_default_role_valid" CHECK (default_role IN ('admin', 'builder', 'operator', 'viewer'));
  END IF;
END $$;--> statement-breakpoint
-- The default space is where a new org member lands, so it can never stop being
-- reachable by one. Validated immediately: the two columns above just defaulted
-- every row to `open`, so the scan this forces cannot fail.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spaces_default_is_open'
      AND conrelid = 'public.spaces'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "spaces" ADD CONSTRAINT "spaces_default_is_open" CHECK (NOT is_default OR visibility = 'open');
  END IF;
END $$;--> statement-breakpoint

-- ═══ C. `space_roles` — org-defined permission bundles ═══════════════════════
--
-- The four presets are code, not rows (spec §13.3): a new space-level
-- permission joins the right preset in the same commit that adds it, where a
-- seeded row would need an N×orgs rewrite. This table holds only the CUSTOM
-- bundles, and `key` may therefore never collide with a preset name.
--
-- The table is created here rather than with the Phase 4 CRUD routes because
-- `space_members.custom_role_id` references it and the resolver reads it from
-- this release on.
CREATE TABLE IF NOT EXISTS "space_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "space_roles_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "space_roles_key_not_preset" CHECK (key NOT IN ('admin', 'builder', 'operator', 'viewer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_space_roles_org_key" ON "space_roles" USING btree ("org_id","key");--> statement-breakpoint
-- Referencing-side index for the `user` SET NULL action (0048's reasoning):
-- Postgres indexes only the REFERENCED side of a foreign key.
CREATE INDEX IF NOT EXISTS "idx_space_roles_created_by" ON "space_roles" USING btree ("created_by");--> statement-breakpoint

-- ═══ D. `space_members` — explicit membership ════════════════════════════════
--
-- Preset-or-custom is TWO nullable columns with a `num_nonnulls` check rather
-- than one column mixing a key and an id, so both halves stay DB-enforced:
-- presets by CHECK, customs by FK.
--
-- `custom_role_id` is ON DELETE RESTRICT, not CASCADE: deleting a role somebody
-- still holds is a 409 naming the count, never a silent loss of access.
--
-- Owners and admins are never rows here — their reach is implied by the org
-- role, the write path refuses an explicit row (409 `redundant_space_role`) and
-- promotion deletes any that exist.
CREATE TABLE IF NOT EXISTS "space_members" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"preset_role" text,
	"custom_role_id" text,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_space_id_user_id_pk" PRIMARY KEY("space_id","user_id"),
	CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "space_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "space_members_custom_role_id_space_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."space_roles"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "space_members_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "space_members_one_role" CHECK (num_nonnulls(preset_role, custom_role_id) = 1),
	CONSTRAINT "space_members_preset_valid" CHECK (preset_role IS NULL OR preset_role IN ('admin', 'builder', 'operator', 'viewer'))
);
--> statement-breakpoint
-- Referencing-side indexes: the `user` CASCADE / SET NULL actions and the
-- `space_roles` RESTRICT check all scan this table by a non-leading column.
CREATE INDEX IF NOT EXISTS "idx_space_members_user_id" ON "space_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_space_members_custom_role_id" ON "space_members" USING btree ("custom_role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_space_members_added_by" ON "space_members" USING btree ("added_by");--> statement-breakpoint

-- ═══ E. Invitations carry the space assignments applied on accept ════════════
ALTER TABLE "org_invitations" ADD COLUMN IF NOT EXISTS "space_assignments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- ═══ F. Chat sessions become space-scoped ════════════════════════════════════
--
-- NULLABLE here, backfilled by `scripts/migration/0008`, NOT NULL in `0057`.
ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "space_id" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_sessions_space_id_spaces_id_fk'
      AND conrelid = 'public.chat_sessions'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_sessions_space_user" ON "chat_sessions" USING btree ("space_id","user_id");--> statement-breakpoint

-- ═══ G. The OIDC auto-provision role allowlist admits `guest` ════════════════
--
-- `oauth_clients.signup_role` writes straight into `org_members.role`, so it
-- shares the org-role vocabulary. Widened rather than replaced: a database that
-- has not yet run `scripts/migration/0008` still holds `viewer` rows, and a
-- narrowing CHECK would fail its own validation scan and abort the batch.
-- `0057` narrows it, after the script has run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_clients_signup_role_check'
      AND conrelid = 'public.oauth_clients'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "oauth_clients" DROP CONSTRAINT "oauth_clients_signup_role_check";
  END IF;
  ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_signup_role_check" CHECK (signup_role IN ('admin', 'member', 'guest', 'viewer'));
END $$;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
