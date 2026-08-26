-- Rename the `application` concept to `space` at the PHYSICAL layer.
--
-- "Application" is the third false friend this schema has carried. The entity
-- is an org-scoped CONTAINER for agents, skills and their connections — the
-- unit every connect-able surface is scoped by — but the word promises "the
-- Appstrate application" to every reader, and the codebase already uses
-- "application" for the platform itself (`application-side`, `apps/api`,
-- `app-generated`) and for third-party OAuth applications (`BYO-app`). Three
-- senses, one word. The concept is renamed from the schema up; this migration
-- is the catalog half of it.
--
-- RENAME, NEVER DROP-AND-RECREATE. `applications` holds live production rows,
-- eighteen tables carry a foreign key into it, and every one of those keys must
-- survive. `ALTER … RENAME` is a catalog-only operation: no table rewrite, no
-- data movement, no window in which a constraint is absent. The one exception
-- is the three CHECK constraints whose BODY spells the retired word — see
-- ═══ THE THREE LEVEL CHECKS ═══ below.
--
-- ═══ WHAT THIS MIGRATION DOES ═══
--
--   1. four tables:  applications → spaces, application_packages →
--      space_packages, application_smtp_configs → space_smtp_configs,
--      application_social_providers → space_social_providers;
--   2. eighteen columns: `application_id` on seventeen tables and
--      `referenced_application_id` on `oauth_clients`, all → `space_id` /
--      `referenced_space_id`;
--   3. every constraint whose NAME carries the retired word — primary keys
--      (including the implicit `applications_pkey`), the eighteen foreign keys,
--      the two CHECKs on the renamed OIDC tables;
--   4. every index whose name carries it, in two passes (see TRAP 3);
--   5. the three CHECK constraints whose BODY hardcodes the literal
--      `'application'`;
--   6. the `notify.ts` PL/pgSQL functions, whose bodies are stored as TEXT and
--      therefore do NOT follow a column rename (see TRAP 4).
--
-- ═══ WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ═══
--
-- IT REWRITES NO ROW VALUES. Not one. `docs/NO_TRANSITIONAL_CODE.md` §2 puts
-- one-off rewrites of row CONTENTS in `scripts/migration/`, and the values this
-- rename touches are these:
--
--   * `spaces.id` and every `space_id` referencing it — minted `app_…`, now
--     minted `spc_…`;
--   * `webhooks.level` and `oauth_clients.level` — the string `'application'`,
--     now `'space'`;
--   * `user.realm` — `end_user:<app_…>`, now `end_user:<spc_…>`;
--   * persisted permission scope strings naming the concept;
--   * `files.storage_key` and every other key whose leading segment is a
--     space id.
--
-- Those are ONE rewrite, not five: a space id is quoted inside `runs.input`,
-- `runs.result`, `run_logs`, chat message payloads and `audit_events.after`,
-- the realm embeds the id, and the storage key embeds it again. Splitting any
-- one field of it into this file would make the operational script partial and
-- unverifiable — the exact failure mode #1177 shipped (see §"Why this is
-- written down" in `docs/NO_TRANSITIONAL_CODE.md`).
--
-- ┌───────────────────────────────────────────────────────────────────────┐
-- │ DEPLOYING THIS MIGRATION ALONE IS NOT A DEPLOY. It REQUIRES the row   │
-- │ rewrite in `scripts/migration/` in the same window, run by an         │
-- │ operator, followed by the two `VALIDATE CONSTRAINT` statements at the │
-- │ end of ═══ THE THREE LEVEL CHECKS ═══.                                │
-- └───────────────────────────────────────────────────────────────────────┘
--
-- ═══ THE THREE LEVEL CHECKS ═══
--
--   webhooks_level_values      CHECK (level IN ('org', 'application'))
--   webhooks_level_check       CHECK ((level = 'org' AND application_id IS NULL)
--                                  OR (level = 'application' AND application_id IS NOT NULL))
--   oauth_clients_level_check  CHECK (… level = 'application' …)
--
-- A column rename carries CHECK bodies along on its own — Postgres stores them
-- as parsed node trees keyed on attnum, so `application_id` becomes `space_id`
-- in all three without a statement from us. The STRING LITERAL does not: it is
-- data inside the expression, and nothing rewrites it. So all three must be
-- dropped and re-added with `'space'`.
--
-- And at that moment the rows still say `'application'` — the rewrite above has
-- not run yet, and by §2 it cannot run from here. A plain `ADD CONSTRAINT`
-- scans the table and fails. Hence: **`NOT VALID`**.
--
-- `NOT VALID` is the right tool and not a dodge. It skips only the initial
-- full-table verification; the constraint is enforced in full on every INSERT
-- and UPDATE from the instant it exists. So the platform can write `'space'`
-- the moment this migration lands — which it must, since the code deploying
-- alongside writes nothing else — while the un-rewritten rows are tolerated
-- until the operator's script reaches them.
--
-- The alternative was considered and rejected. §2's carve-out ("a backfill that
-- is the precondition of a CHECK, on the same table") would arguably licence
--   `UPDATE webhooks SET level = 'space' WHERE level = 'application';`
-- right here — it is structurally the same shape as `0038`. It is rejected
-- because the `level` values are not separable from the id re-mint described
-- above: `oauth_clients.level = 'application'` co-varies with a `referenced_
-- application_id` holding an `app_…` id and with a `user.realm` embedding the
-- same id. Rewriting one third of that tuple here and the other two thirds in
-- `scripts/migration/` gives the operator no single place to verify, and no
-- single place to roll back. One rewrite, one file, one verification.
--
-- AFTER the row rewrite has run, promote the three constraints:
--
--   ALTER TABLE "webhooks"       VALIDATE CONSTRAINT "webhooks_level_values";
--   ALTER TABLE "webhooks"       VALIDATE CONSTRAINT "webhooks_level_check";
--   ALTER TABLE "oauth_clients"  VALIDATE CONSTRAINT "oauth_clients_level_check";
--
-- Until then a stale row is readable and re-writable only into a legal value.
-- Note the snapshot records a check as `{name, value}` and has no notion of
-- validity, so `NOT VALID` produces no drizzle-kit drift either way.
--
-- ═══ FOUR TRAPS THIS MIGRATION IS WRITTEN AGAINST ═══
--
-- TRAP 1 — **Postgres does not always name a constraint the way Drizzle does.**
--   This repo has been bitten by `_fkey` vs `_fk` drift before, and at least one
--   survivor is still in this schema (`cli_refresh_tokens_parent_id_fkey`).
--   Implicit primary keys are worse: `applications_pkey` is written in no file
--   at all. So the constraint pass below does NOT enumerate names — it reads
--   `pg_constraint` for whatever is actually attached, and rewrites
--   `application` → `space` INSIDE each name. A name that is not there cannot
--   fail; a name that drifted is carried forward with its drift intact rather
--   than being invented.
--
-- TRAP 2 — **Renaming a table auto-renames nothing else.** Its indexes, its
--   constraints and its sequences keep their old names. Hence the explicit
--   passes. Renaming a CONSTRAINT does rename its backing index, so the
--   constraint pass runs FIRST and the index passes then see only free-standing
--   indexes.
--
-- TRAP 3 — **Nine index names spell the concept `app`, not `application`.**
--   `idx_runs_app_started`, `idx_uploads_app`, `idx_files_org_app_created` …
--   No `replace()` reaches them without also mangling names where `app` means
--   something else, so pass 4b enumerates them. That is not a violation of
--   TRAP 1's rule: a free-standing index name is never Postgres-generated —
--   every one of these nine is written verbatim in a `CREATE INDEX` in this
--   folder and in `packages/db/src/schema/*.ts`. TRAP 1 forbids enumerating
--   names that exist in no file; these are exactly the opposite case. Each is
--   still guarded, so a missing one is a no-op.
--
-- TRAP 4 — **A column rename does not touch a PL/pgSQL function body.** Trigger
--   WHEN clauses are parsed trees and DO follow the rename (the
--   `runs_notify_update_trigger` guard listing `OLD.application_id` fixes
--   itself). Function bodies are stored as TEXT: `notify_run_change` would keep
--   emitting `NEW.application_id`, and EVERY INSERT AND UPDATE ON `runs` would
--   error. Step 7 reinstalls all three functions and their triggers.
--
--   Do NOT rely on the runtime reinstall for this. `boot.ts` calls
--   `createNotifyTriggers()` from `bootBackground()` — after the port binds —
--   and its failure is caught and only `logger.warn`ed. The window between the
--   migration and that call is a window in which no run can start, and a failed
--   call leaves the database permanently broken while `/health` reports green.
--
-- ═══ IDEMPOTENCY ═══
--
-- Every step is guarded by an EXISTS check on the catalog, so a partially
-- applied environment converges and a re-run is a no-op. The three CHECK
-- constraints are re-created only while their stored definition still contains
-- the retired literal — a replay therefore cannot silently de-validate a
-- constraint an operator has already promoted with `VALIDATE CONSTRAINT`. The
-- function reinstalls are `CREATE OR REPLACE`; the trigger reinstalls drop by
-- name inside an existence check, exactly as `createNotifyTriggers` does.
--
-- ═══ ROLLBACK ═══
--
-- This repo has no down migrations. The reverse is below; a database snapshot
-- taken before the deploy remains the fast path.
--
--   -- 1. the three CHECK bodies, back to the retired literal
--   ALTER TABLE "webhooks" DROP CONSTRAINT IF EXISTS "webhooks_level_values";
--   ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_level_values"
--     CHECK (level IN ('org', 'application')) NOT VALID;
--   ALTER TABLE "webhooks" DROP CONSTRAINT IF EXISTS "webhooks_level_check";
--   ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_level_check"
--     CHECK ((level = 'org' AND space_id IS NULL)
--         OR (level = 'application' AND space_id IS NOT NULL)) NOT VALID;
--   ALTER TABLE "oauth_clients" DROP CONSTRAINT IF EXISTS "oauth_clients_level_check";
--   ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_level_check"
--     CHECK ((level = 'org' AND referenced_org_id IS NOT NULL AND referenced_space_id IS NULL)
--         OR (level = 'application' AND referenced_space_id IS NOT NULL AND referenced_org_id IS NULL)
--         OR (level = 'instance' AND referenced_org_id IS NULL AND referenced_space_id IS NULL)) NOT VALID;
--
--   -- 2. the nine `app`-spelled indexes (pass 4b), reversed
--   ALTER INDEX "public"."idx_end_users_space_email"        RENAME TO "idx_end_users_app_email";
--   ALTER INDEX "public"."idx_runs_space_status_started"    RENAME TO "idx_runs_app_status_started";
--   ALTER INDEX "public"."idx_runs_space_started"           RENAME TO "idx_runs_app_started";
--   ALTER INDEX "public"."idx_package_schedules_space_id"   RENAME TO "idx_package_schedules_app_id";
--   ALTER INDEX "public"."idx_integration_conn_space"       RENAME TO "idx_integration_conn_app";
--   ALTER INDEX "public"."idx_uploads_space"                RENAME TO "idx_uploads_app";
--   ALTER INDEX "public"."idx_webhooks_space_enabled"       RENAME TO "idx_webhooks_app_enabled";
--   ALTER INDEX "public"."idx_oauth_clients_space"          RENAME TO "idx_oauth_clients_app";
--   ALTER INDEX "public"."idx_files_org_space_created"      RENAME TO "idx_files_org_app_created";
--
--   -- 3. the catalog-driven index pass, reversed. `replace('space',
--   --    'application')` is safe in the other direction too: BEFORE this
--   --    migration ran, no relation, column, index or constraint name in this
--   --    schema contained the substring `space` — verified against
--   --    meta/0052_snapshot.json — so nothing incidental can be caught.
--   DO $$
--   DECLARE r record;
--   BEGIN
--     FOR r IN
--       SELECT c.relname AS idxname FROM pg_class c
--       JOIN pg_namespace n ON n.oid = c.relnamespace
--       WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname LIKE '%space%'
--     LOOP
--       EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', 'public', r.idxname,
--                      replace(r.idxname, 'space', 'application'));
--     END LOOP;
--   END $$;
--
--   -- 4. the catalog-driven constraint pass, reversed
--   DO $$
--   DECLARE r record;
--   BEGIN
--     FOR r IN
--       SELECT c.conname, quote_ident(n.nspname) || '.' || quote_ident(t.relname) AS tbl
--       FROM pg_constraint c
--       JOIN pg_class t ON t.oid = c.conrelid
--       JOIN pg_namespace n ON n.oid = t.relnamespace
--       WHERE n.nspname = 'public' AND c.conname LIKE '%space%'
--     LOOP
--       EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname,
--                      replace(r.conname, 'space', 'application'));
--     END LOOP;
--   END $$;
--
--   -- 5. the eighteen columns
--   DO $$
--   DECLARE r record;
--   BEGIN
--     FOR r IN
--       SELECT table_name, column_name FROM information_schema.columns
--       WHERE table_schema = 'public' AND column_name IN ('space_id', 'referenced_space_id')
--     LOOP
--       EXECUTE format('ALTER TABLE %I.%I RENAME COLUMN %I TO %I', 'public',
--                      r.table_name, r.column_name,
--                      replace(r.column_name, 'space', 'application'));
--     END LOOP;
--   END $$;
--
--   -- 6. the four tables
--   ALTER TABLE "spaces"                  RENAME TO "applications";
--   ALTER TABLE "space_packages"          RENAME TO "application_packages";
--   ALTER TABLE "space_smtp_configs"      RENAME TO "application_smtp_configs";
--   ALTER TABLE "space_social_providers"  RENAME TO "application_social_providers";
--
--   -- 7. the PL/pgSQL bodies. Reinstalling the PREVIOUS release's spelling is
--   --    not optional — after step 5 the current bodies name a column that no
--   --    longer exists. Redeploying the previous release does it at boot
--   --    (`createNotifyTriggers`), but that runs in `bootBackground()` and only
--   --    warns on failure, so run that release's `createNotifyTriggers()`
--   --    deliberately, or re-apply the `notify_run_change` /
--   --    `notify_run_log_insert` / `notify_integration_connection_change`
--   --    bodies from `packages/db/src/notify.ts` at its commit.
--
--   -- 8. AND THE ROW REWRITE IS YOURS TO UNDO TOO, in the same window, if the
--   --    operator's `scripts/migration/` pass already ran. Reversing the
--   --    catalog without reversing the values leaves the previous release
--   --    reading `spc_…` ids through a validator that accepts only `app_…`.

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1: the four tables.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.applications') IS NOT NULL
     AND to_regclass('public.spaces') IS NULL THEN
    ALTER TABLE "applications" RENAME TO "spaces";
  END IF;
  IF to_regclass('public.application_packages') IS NOT NULL
     AND to_regclass('public.space_packages') IS NULL THEN
    ALTER TABLE "application_packages" RENAME TO "space_packages";
  END IF;
  IF to_regclass('public.application_smtp_configs') IS NOT NULL
     AND to_regclass('public.space_smtp_configs') IS NULL THEN
    ALTER TABLE "application_smtp_configs" RENAME TO "space_smtp_configs";
  END IF;
  IF to_regclass('public.application_social_providers') IS NOT NULL
     AND to_regclass('public.space_social_providers') IS NULL THEN
    ALTER TABLE "application_social_providers" RENAME TO "space_social_providers";
  END IF;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2: the eighteen columns — `application_id` on api_keys, end_users,
-- space_packages, package_persistence, runs, package_schedules, notifications,
-- integration_connections, integration_oauth_clients, integration_pins,
-- integration_org_defaults, uploads, files, audit_events, webhooks,
-- space_smtp_configs and space_social_providers, plus
-- `oauth_clients.referenced_application_id`.
--
-- Catalog-driven rather than seventeen `ALTER TABLE` lines: the set of tables
-- carrying the FK is the thing most likely to have grown since this file was
-- written, and a name that is not there cannot fail. Renaming the column
-- carries every dependent CHECK body, index expression and trigger WHEN clause
-- with it — all three are stored as parsed trees keyed on attnum.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('application_id', 'referenced_application_id')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I RENAME COLUMN %I TO %I',
      'public', r.table_name, r.column_name,
      replace(r.column_name, 'application', 'space')
    );
  END LOOP;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3: constraints. Every primary key, foreign key and CHECK in `public`
-- whose NAME carries the retired word — across ALL tables, not just the four
-- renamed ones, because eighteen tables hold a `*_application_id_applications_
-- id_fk`. Catalog-driven (TRAP 1); `replace()` maps every expected name onto
-- exactly the name the Drizzle schema now declares —
--
--   applications_pkey                                    -> spaces_pkey
--   applications_org_id_organizations_id_fk              -> spaces_org_id_organizations_id_fk
--   applications_created_by_user_id_fk                   -> spaces_created_by_user_id_fk
--   runs_application_id_applications_id_fk               -> runs_space_id_spaces_id_fk
--   application_packages_application_id_package_id_pk    -> space_packages_space_id_package_id_pk
--   application_social_providers_application_id_provider_pk
--                                                        -> space_social_providers_space_id_provider_pk
--   application_smtp_configs_secure_mode_check           -> space_smtp_configs_secure_mode_check
--   application_social_providers_provider_check          -> space_social_providers_provider_check
--   oauth_clients_referenced_application_id_applications_id_fk
--                                                        -> oauth_clients_referenced_space_id_spaces_id_fk
--   … and the remaining foreign keys, identically.
--
-- Renaming a constraint also renames its backing index, so the PK and unique
-- indexes are handled here and skipped by step 4 (TRAP 2).
--
-- The three `*_level_*` CHECKs are NOT matched here: their names carry no
-- `application`, only their bodies do. Step 5 owns them.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname,
           quote_ident(n.nspname) || '.' || quote_ident(t.relname) AS tbl
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND c.conname LIKE '%application%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
      r.tbl, r.conname, replace(r.conname, 'application', 'space')
    );
  END LOOP;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4a: free-standing indexes whose name spells `application` in full —
--   idx_applications_org_id, idx_applications_one_default,
--   idx_end_users_application_id, idx_api_keys_application_id,
--   idx_application_packages_package_id, idx_files_application.
-- Same catalog-driven rewrite. Anything already renamed by step 3 no longer
-- matches the LIKE and is skipped.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS idxname, n.nspname AS schemaname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname LIKE '%application%'
  LOOP
    EXECUTE format(
      'ALTER INDEX %I.%I RENAME TO %I',
      r.schemaname, r.idxname, replace(r.idxname, 'application', 'space')
    );
  END LOOP;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4b: the nine indexes that spell the concept `app` (TRAP 3). Enumerated
-- because no `replace()` distinguishes this `app` from the one in `apps/api`
-- or `BYO-app`; every name below is written verbatim in `schema/*.ts`, so
-- enumerating it reads a name rather than inventing one. Each pair is guarded
-- on BOTH sides — the old name must exist and the new one must not — so a
-- partially applied environment converges and a replay is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('idx_end_users_app_email',      'idx_end_users_space_email'),
      ('idx_runs_app_status_started',  'idx_runs_space_status_started'),
      ('idx_runs_app_started',         'idx_runs_space_started'),
      ('idx_package_schedules_app_id', 'idx_package_schedules_space_id'),
      ('idx_integration_conn_app',     'idx_integration_conn_space'),
      ('idx_uploads_app',              'idx_uploads_space'),
      ('idx_webhooks_app_enabled',     'idx_webhooks_space_enabled'),
      ('idx_oauth_clients_app',        'idx_oauth_clients_space'),
      ('idx_files_org_app_created',    'idx_files_org_space_created')
    ) AS t(old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = r.old_name
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = r.new_name
    ) THEN
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', 'public', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 5: the three CHECK constraints whose BODY hardcodes `'application'`.
-- Re-added `NOT VALID` — the rows still hold the retired literal and this file
-- may not rewrite them. Read ═══ THE THREE LEVEL CHECKS ═══ in the header for
-- the full argument, and for the two `VALIDATE CONSTRAINT` statements the
-- operator runs after `scripts/migration/`.
--
-- Guarded on the STORED DEFINITION, not on mere existence: a replay must not
-- de-validate a constraint an operator has already promoted.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  d text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO d
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'webhooks'
    AND c.conname = 'webhooks_level_values';
  IF d IS NULL OR d LIKE '%''application''%' THEN
    ALTER TABLE "webhooks" DROP CONSTRAINT IF EXISTS "webhooks_level_values";
    ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_level_values"
      CHECK (level IN ('org', 'space')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint

DO $$
DECLARE
  d text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO d
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'webhooks'
    AND c.conname = 'webhooks_level_check';
  IF d IS NULL OR d LIKE '%''application''%' THEN
    ALTER TABLE "webhooks" DROP CONSTRAINT IF EXISTS "webhooks_level_check";
    ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_level_check"
      CHECK ((level = 'org' AND space_id IS NULL)
          OR (level = 'space' AND space_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;--> statement-breakpoint

DO $$
DECLARE
  d text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO d
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'oauth_clients'
    AND c.conname = 'oauth_clients_level_check';
  IF d IS NULL OR d LIKE '%''application''%' THEN
    ALTER TABLE "oauth_clients" DROP CONSTRAINT IF EXISTS "oauth_clients_level_check";
    ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_level_check"
      CHECK ((level = 'org' AND referenced_org_id IS NOT NULL AND referenced_space_id IS NULL)
          OR (level = 'space' AND referenced_space_id IS NOT NULL AND referenced_org_id IS NULL)
          OR (level = 'instance' AND referenced_org_id IS NULL AND referenced_space_id IS NULL))
      NOT VALID;
  END IF;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 6: sequences owned by the four renamed tables. None of them has one
-- today (every PK is a platform-minted `text`), but a table rename never
-- carries a sequence name along, so the pass exists so a future serial column
-- cannot silently keep the retired name. Kept identical to `0043` step 6.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS seqname, n.nspname AS schemaname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE c.relkind = 'S'
      AND tn.nspname = 'public'
      AND t.relname IN ('spaces', 'space_packages', 'space_smtp_configs',
                        'space_social_providers')
      AND c.relname LIKE '%application%'
  LOOP
    EXECUTE format(
      'ALTER SEQUENCE %I.%I RENAME TO %I',
      r.schemaname, r.seqname, replace(r.seqname, 'application', 'space')
    );
  END LOOP;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 7 (TRAP 4): reinstall the NOTIFY functions and triggers. Their bodies
-- are stored as TEXT and still emit `NEW.application_id`, which no longer
-- exists — without this, every INSERT and UPDATE on `runs`, every INSERT on
-- `run_logs` and every write to `integration_connections` raises.
--
-- The JSON payload KEY changes with the column: the SSE subscriber's
-- snake-to-camel mapper reads `space_id` from this release on.
--
-- Byte-identical to `createNotifyTriggers()` in `packages/db/src/notify.ts`, so
-- the boot-time reinstall that follows is a genuine no-op rather than a second
-- opinion. Keep the two in step.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_run_change()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('run_update', json_build_object(
    'operation', TG_OP,
    'id', NEW.id,
    'package_id', NEW.package_id,
    'status', NEW.status,
    'user_id', NEW.user_id,
    'end_user_id', NEW.end_user_id,
    'org_id', NEW.org_id,
    'space_id', NEW.space_id,
    'schedule_id', NEW.schedule_id,
    'error', LEFT(NEW.error, 2000),
    'started_at', to_char(NEW.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'completed_at', to_char(NEW.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'duration', NEW.duration
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION notify_run_log_insert()
RETURNS TRIGGER AS $$
DECLARE
  _space_id text;
BEGIN
  SELECT space_id INTO _space_id FROM runs WHERE id = NEW.run_id;
  PERFORM pg_notify('run_log_insert', json_build_object(
    'id', NEW.id,
    'run_id', NEW.run_id,
    'org_id', NEW.org_id,
    'space_id', _space_id,
    'type', NEW.type,
    'level', NEW.level,
    'event', NEW.event,
    'message', LEFT(NEW.message, 2000),
    'data', CASE
      WHEN NEW.data IS NULL THEN NULL
      WHEN octet_length(NEW.data::text) <= 6000 THEN NEW.data
      ELSE '"[payload too large]"'::jsonb
    END,
    'created_at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION notify_integration_connection_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM pg_notify('connection_update', json_build_object(
      'operation', TG_OP,
      'id', OLD.id,
      'integration_package_id', OLD.integration_package_id,
      'auth_key', OLD.auth_key,
      'user_id', OLD.user_id,
      'end_user_id', OLD.end_user_id,
      'space_id', OLD.space_id,
      'needs_reconnection', NULL,
      'deleted', TRUE
    )::text);
    RETURN OLD;
  ELSE
    PERFORM pg_notify('connection_update', json_build_object(
      'operation', TG_OP,
      'id', NEW.id,
      'integration_package_id', NEW.integration_package_id,
      'auth_key', NEW.auth_key,
      'user_id', NEW.user_id,
      'end_user_id', NEW.end_user_id,
      'space_id', NEW.space_id,
      'needs_reconnection', NEW.needs_reconnection,
      'deleted', FALSE
    )::text);
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- The triggers themselves need no rewrite — a trigger binds its function by OID
-- and its WHEN clause is a parsed tree that followed step 2's column rename.
-- They are re-created anyway, identically to `createNotifyTriggers`, so that an
-- environment whose triggers were dropped by hand converges here rather than in
-- `bootBackground()`.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'runs_notify_trigger') THEN
    DROP TRIGGER runs_notify_trigger ON runs;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'runs_notify_insert_trigger') THEN
    DROP TRIGGER runs_notify_insert_trigger ON runs;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'runs_notify_update_trigger') THEN
    DROP TRIGGER runs_notify_update_trigger ON runs;
  END IF;
  CREATE TRIGGER runs_notify_insert_trigger
    AFTER INSERT ON runs
    FOR EACH ROW EXECUTE FUNCTION notify_run_change();
  CREATE TRIGGER runs_notify_update_trigger
    AFTER UPDATE ON runs
    FOR EACH ROW
    WHEN (
      OLD.id IS DISTINCT FROM NEW.id
      OR OLD.package_id IS DISTINCT FROM NEW.package_id
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.user_id IS DISTINCT FROM NEW.user_id
      OR OLD.end_user_id IS DISTINCT FROM NEW.end_user_id
      OR OLD.org_id IS DISTINCT FROM NEW.org_id
      OR OLD.space_id IS DISTINCT FROM NEW.space_id
      OR OLD.schedule_id IS DISTINCT FROM NEW.schedule_id
      OR OLD.error IS DISTINCT FROM NEW.error
      OR OLD.started_at IS DISTINCT FROM NEW.started_at
      OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
      OR OLD.duration IS DISTINCT FROM NEW.duration
    )
    EXECUTE FUNCTION notify_run_change();
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'run_logs_notify_trigger') THEN
    DROP TRIGGER run_logs_notify_trigger ON run_logs;
  END IF;
  CREATE TRIGGER run_logs_notify_trigger
    AFTER INSERT ON run_logs
    FOR EACH ROW EXECUTE FUNCTION notify_run_log_insert();
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'integration_connections_notify_trigger') THEN
    DROP TRIGGER integration_connections_notify_trigger ON integration_connections;
  END IF;
  CREATE TRIGGER integration_connections_notify_trigger
    AFTER INSERT OR UPDATE OR DELETE ON integration_connections
    FOR EACH ROW EXECUTE FUNCTION notify_integration_connection_change();
END $$;
