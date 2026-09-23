-- 0018 — realign a database created before the `0000_init.sql` squash with the
-- schema the migration chain builds (#1507).
--
-- The drift: a database that existed before #481 squashed the migrations into
-- `0000_init.sql` never received what the squash introduced rather than a
-- forward migration. Its `drizzle.__drizzle_migrations` journal is complete (69
-- rows at beta.60), so nothing flags it — only a catalog diff against a
-- migrate-built database does. Measured on production's pre-beta.60 dump:
--
--   1. 60 columns across 26 tables are `timestamp` (no time zone) where the
--      chain has `timestamptz` — the only column-level difference;
--   2. enum `package_type` still carries `provider` and `tool`, retired by #481,
--      used by 16 `packages` (6 orphaned system packages, 10 local) and by 148
--      `package_version_dependencies` rows;
--   3. 19 constraints (4 of them backing a unique index or a primary key) carry
--      Postgres' auto-names (`*_fkey`, `*_key`, `*_pkey`) instead of Drizzle's;
--   4. 6 constraints the chain declares are absent: 5 CHECKs and 1 FK;
--   5. one index the chain deliberately does not have: `idx_runs_space_id`
--      (the runs schema comment calls it redundant with the two composites led
--      by `space_id`).
--
-- Why this is here and not in packages/db/drizzle/: the chain already IS the
-- schema. This repairs the databases that predate a squash of it, once. See
-- docs/NO_TRANSITIONAL_CODE.md §2.
--
-- What it deletes, and why that is the current projection rather than a
-- choice:
--   * the 148 `package_version_dependencies` rows typed `provider`/`tool`. That
--     table is a derived index of `manifest.dependencies`, read only for cycle
--     detection at publish (`resolvePublishedDeps`). `extractDependencies`
--     (`@appstrate/core/dependencies`) reads `skills`, `mcp_servers` and
--     `integrations` and treats `providers`/`tools` as retired keys, so
--     re-deriving the index from the same manifests produces none of them.
--   * the 16 packages typed `provider`/`tool`, with their versions, dist-tags
--     and the 2 `space_packages` installing them — the code no longer knows the
--     type, none of them has a run, a connection, a schedule or a webhook.
--     Decided 2026-09-23. Their 19 version artifacts in object storage are left
--     behind; list them BEFORE running this (query below) to clean up
--     separately.
--
-- Lock profile: every timestamp column change and the enum retype REWRITE
-- their table under ACCESS EXCLUSIVE. Run it with the app container stopped —
-- `docker stop` the app, not a Coolify "stop", which is a compose down that
-- prunes images — then start it again; nothing else needs to move.
--
-- REHEARSED 2026-09-23 on production's pre-beta.60 dump (62 tables, 245 596
-- rows, `run_logs` 209 906), throwaway postgres:16-alpine:
--   applied in 6.0 s, one transaction; a second run in 0.3 s changing nothing;
--   before → after: 60 → 0 `timestamp` columns, 2 → 0 retired labels, 19 → 0
--   auto-names, 1 → 0 redundant index, 6 constraints added and validated;
--   deleted exactly: 148 dependency rows, 2 `space_packages`, 16
--   `package_dist_tags`, 19 `package_versions`, 16 `packages` — every other
--   table's row count unchanged;
--   `sum(extract(epoch from runs.started_at))` identical before and after
--   (10090656128597): the values are the same instants;
--   the 5 triggers' definitions identical before and after;
--   catalog diff against a migrate-built database (columns, indexes,
--   constraints with their validation state, enum labels in order): EMPTY;
--   `ghcr.io/appstrate/appstrate:1.0.0-beta.60` booted on the result with the
--   production module set: `Server ready`, 0 `level:50`, 0 column/enum error.
--
-- Idempotent: every step is guarded by the catalog condition it removes — a
-- second run finds no `timestamp` column, no retired label, no auto-name, no
-- missing constraint, no redundant index, and changes nothing.
--
-- ═══ VERIFY ═══
--
-- Before (on a drifted database) — non-zero; after — all 0:
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_schema = 'public' AND udt_name = 'timestamp';                 -- 60 → 0
--   SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
--   WHERE t.typname = 'package_type' AND e.enumlabel IN ('provider', 'tool'); -- 2 → 0
--   -- the 19 old names of step 4 (not a `_(fkey|key|pkey)$` pattern: the chain
--   -- itself names every single-column primary key `<table>_pkey`)
--   SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
--     AND conname IN ('cli_refresh_tokens_client_id_fkey', 'cli_refresh_tokens_token_hash_key',
--       'cli_refresh_tokens_user_id_fkey', 'device_codes_client_id_fkey',
--       'device_codes_device_code_key', 'device_codes_user_code_key', 'device_codes_user_id_fkey',
--       'org_models_credential_id_fkey', 'package_persistence_org_id_fkey',
--       'package_persistence_package_id_fkey', 'package_persistence_run_id_fkey',
--       'package_persistence_space_id_fkey', 'space_smtp_configs_space_id_fkey',
--       'space_social_providers_pkey', 'space_social_providers_space_id_fkey',
--       'webhook_deliveries_webhook_id_fkey', 'webhooks_org_id_fkey', 'webhooks_package_id_fkey',
--       'webhooks_space_id_fkey');                                            -- 19 → 0
--   SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_runs_space_id';   -- 1 → 0
-- After — all 6 present and validated:
--   SELECT conname, convalidated FROM pg_constraint WHERE conname IN (
--     'model_provider_pairings_credential_id_fk', 'org_models_source_valid',
--     'org_proxies_source_valid', 'package_versions_manifest_v0',
--     'packages_draft_manifest_v0', 'run_logs_level_valid');
--
-- The object-storage keys the deletion orphans — run BEFORE, keep the output:
--   SELECT v.package_id, v.version FROM package_versions v JOIN packages p
--   ON p.id = v.package_id WHERE p.type::text IN ('provider', 'tool');
--
-- The discriminating check is the one that found the drift: restore a dump,
-- apply this, and diff its catalog (columns, indexes, constraints, enum labels)
-- against a database built by `bun packages/db/src/migrate.ts` — expected
-- difference: none outside `ee_*` and the boot-installed NOTIFY triggers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- ── 1. Retired package types: the derived dependency rows, then the packages ──
DELETE FROM "package_version_dependencies" WHERE "dep_type"::text IN ('provider', 'tool');
DELETE FROM "space_packages" WHERE "package_id" IN (
  SELECT "id" FROM "packages" WHERE "type"::text IN ('provider', 'tool'));
DELETE FROM "package_dist_tags" WHERE "package_id" IN (
  SELECT "id" FROM "packages" WHERE "type"::text IN ('provider', 'tool'));
DELETE FROM "package_version_dependencies" WHERE "version_id" IN (
  SELECT v."id" FROM "package_versions" v JOIN "packages" p ON p."id" = v."package_id"
  WHERE p."type"::text IN ('provider', 'tool'));
DELETE FROM "package_versions" WHERE "package_id" IN (
  SELECT "id" FROM "packages" WHERE "type"::text IN ('provider', 'tool'));
DELETE FROM "packages" WHERE "type"::text IN ('provider', 'tool');

-- ── 2. package_type without the retired labels, in the chain's label order ──
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'package_type' AND e.enumlabel IN ('provider', 'tool')) THEN
    ALTER TYPE "public"."package_type" RENAME TO "package_type_0018_retired";
    CREATE TYPE "public"."package_type" AS ENUM('agent', 'skill', 'integration', 'mcp-server');
    FOR r IN SELECT table_name, column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND udt_name = 'package_type_0018_retired' LOOP
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE "public"."package_type" USING %I::text::"public"."package_type"',
                     r.table_name, r.column_name, r.column_name);
    END LOOP;
    DROP TYPE "public"."package_type_0018_retired";
  END IF;
END $$;

-- ── 3. timestamp → timestamptz, one rewrite per table; values read as UTC ──
-- A column a trigger's WHEN clause reads cannot change type under it
-- (`runs_notify_update_trigger` reads `runs.completed_at`), so each table's
-- triggers are read back with pg_get_triggerdef, dropped, and recreated
-- verbatim after the rewrite — the boot-installed definitions, not a copy of
-- them kept here.
DO $$
DECLARE r record; tg record; defs text[]; d text;
BEGIN
  IF current_setting('TimeZone') <> 'UTC' THEN
    RAISE EXCEPTION '0018: session TimeZone is %, expected UTC — the stored values were written in UTC', current_setting('TimeZone');
  END IF;
  FOR r IN SELECT table_name,
                  string_agg(format('ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE %L',
                                    column_name, column_name, 'UTC'), ', ' ORDER BY column_name) AS alters
           FROM information_schema.columns
           WHERE table_schema = 'public' AND udt_name = 'timestamp'
           GROUP BY table_name ORDER BY table_name LOOP
    defs := ARRAY[]::text[];
    FOR tg IN SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
              WHERE tgrelid = format('public.%I', r.table_name)::regclass AND NOT tgisinternal LOOP
      defs := defs || tg.def;
      EXECUTE format('DROP TRIGGER %I ON %I', tg.tgname, r.table_name);
    END LOOP;
    EXECUTE format('ALTER TABLE %I %s', r.table_name, r.alters);
    FOREACH d IN ARRAY defs LOOP
      EXECUTE d;
    END LOOP;
  END LOOP;
END $$;

-- ── 4. Postgres auto-names → the chain's Drizzle names ──
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('cli_refresh_tokens',     'cli_refresh_tokens_client_id_fkey',     'cli_refresh_tokens_client_id_oauth_clients_client_id_fk'),
    ('cli_refresh_tokens',     'cli_refresh_tokens_token_hash_key',     'cli_refresh_tokens_token_hash_unique'),
    ('cli_refresh_tokens',     'cli_refresh_tokens_user_id_fkey',       'cli_refresh_tokens_user_id_user_id_fk'),
    ('device_codes',           'device_codes_client_id_fkey',           'device_codes_client_id_oauth_clients_client_id_fk'),
    ('device_codes',           'device_codes_device_code_key',          'device_codes_device_code_unique'),
    ('device_codes',           'device_codes_user_code_key',            'device_codes_user_code_unique'),
    ('device_codes',           'device_codes_user_id_fkey',             'device_codes_user_id_user_id_fk'),
    ('org_models',             'org_models_credential_id_fkey',         'org_models_credential_id_model_provider_credentials_id_fk'),
    ('package_persistence',    'package_persistence_org_id_fkey',       'package_persistence_org_id_organizations_id_fk'),
    ('package_persistence',    'package_persistence_package_id_fkey',   'package_persistence_package_id_packages_id_fk'),
    ('package_persistence',    'package_persistence_run_id_fkey',       'package_persistence_run_id_runs_id_fk'),
    ('package_persistence',    'package_persistence_space_id_fkey',     'package_persistence_space_id_spaces_id_fk'),
    ('space_smtp_configs',     'space_smtp_configs_space_id_fkey',      'space_smtp_configs_space_id_spaces_id_fk'),
    ('space_social_providers', 'space_social_providers_pkey',           'space_social_providers_space_id_provider_pk'),
    ('space_social_providers', 'space_social_providers_space_id_fkey',  'space_social_providers_space_id_spaces_id_fk'),
    ('webhook_deliveries',     'webhook_deliveries_webhook_id_fkey',    'webhook_deliveries_webhook_id_webhooks_id_fk'),
    ('webhooks',               'webhooks_org_id_fkey',                  'webhooks_org_id_organizations_id_fk'),
    ('webhooks',               'webhooks_package_id_fkey',              'webhooks_package_id_packages_id_fk'),
    ('webhooks',               'webhooks_space_id_fkey',                'webhooks_space_id_spaces_id_fk')
  ) AS t(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = r.tbl::regclass AND conname = r.old_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- ── 5. The constraints the chain declares and this database lacks ──
-- Added NOT VALID (no scan under the lock), then validated: a violating row
-- aborts the whole transaction and names the constraint.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('model_provider_pairings', 'model_provider_pairings_credential_id_fk',
     'FOREIGN KEY ("credential_id") REFERENCES "public"."model_provider_credentials"("id") ON DELETE set null'),
    ('org_models',       'org_models_source_valid',      $c$CHECK (source IN ('built-in', 'custom'))$c$),
    ('org_proxies',      'org_proxies_source_valid',     $c$CHECK (source IN ('built-in', 'custom'))$c$),
    ('package_versions', 'package_versions_manifest_v0',
     $c$CHECK ("manifest" IS NULL OR ("manifest" ->> 'schema_version') IS NULL OR ("manifest" ->> 'schema_version') LIKE '0.%')$c$),
    ('packages',         'packages_draft_manifest_v0',
     $c$CHECK ("draft_manifest" IS NULL OR ("draft_manifest" ->> 'schema_version') IS NULL OR ("draft_manifest" ->> 'schema_version') LIKE '0.%')$c$),
    ('run_logs',         'run_logs_level_valid',         $c$CHECK (level IN ('debug', 'info', 'warn', 'error'))$c$)
  ) AS t(tbl, name, def) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = r.tbl::regclass AND conname = r.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID', r.tbl, r.name, r.def);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = r.tbl::regclass AND conname = r.name AND NOT convalidated) THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', r.tbl, r.name);
    END IF;
  END LOOP;
END $$;

-- ── 6. The index the chain does not have ──
DROP INDEX IF EXISTS "public"."idx_runs_space_id";

COMMIT;
