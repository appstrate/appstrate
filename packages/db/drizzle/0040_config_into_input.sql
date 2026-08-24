-- Collapse the manifest `config` schema into `input`.
--
-- The platform used to carry two parameter namespaces per agent. It now carries
-- one. This migration moves every column that expressed the split onto the
-- surviving `input` side, then drops the split.
--
-- FORWARD-ONLY and data-preserving: every value a dropped column held is folded
-- into its `input` counterpart BEFORE the DROP, so no row loses a parameter.
--
-- Collision rule, used identically in all three folds: `input` wins. `a || b` is
-- a shallow jsonb merge where the RIGHT operand takes precedence, so `input` is
-- always written on the right. A key present in both keeps the `input` value —
-- the same property the manifest merge applied.
--
-- APPLIED EXACTLY ONCE, and it does not need to survive a re-run. Neither
-- migrator in this repo keys on file CONTENT, so editing this file — its header
-- included — does not make an existing database replay it:
--
--   * `drizzle-orm`'s pg dialect (`pg-core/dialect.js`, used by the postgres-js
--     migrator in `apps/api/src/lib/boot.ts`) applies a migration only when
--     `Number(lastDbMigration.created_at) < migration.folderMillis` — a
--     TIMESTAMP WATERMARK read from `drizzle.__drizzle_migrations`. The content
--     hash is written to that table and never compared. `boot.ts`'s
--     `reconcileOAuthResourceColumns` docblock states the same rule from the
--     other direction: a watermark ahead of reality SKIPS a migration.
--   * `applyCorePGliteMigrations` (`apps/api/src/lib/pglite-migrate.ts`, tier 0)
--     keys on the journal TAG. `0040_config_into_input` has not changed.
--
-- DO NOT gate the `application_packages` wrap on "does this row already look
-- wrapped?". `config` held ARBITRARY author-declared parameter names, so an
-- agent that declared parameters spelled `values` and `locked` (the latter an
-- array) is byte-indistinguishable from an already-wrapped row: a shape-sniffing
-- WHERE SKIPS it, `getInstalledPackageSettings` then resolves
-- `asRecord("prod")` to `{}`, and the agent's configured values are gone while a
-- field that does not exist reads as locked. Nothing errors. There is no sound
-- shape test — the guard trades a re-run that cannot happen for silent data loss
-- that can. Covered by
-- `apps/api/test/integration/db/config-into-input-migration.test.ts`.
--
-- The statements that CAN converge soundly do, for a partially-applied
-- environment rather than for a replay: the RENAME is catalog-guarded (it
-- errored once `config` was gone), each fold is gated on its source column still
-- existing, and the drops are `IF EXISTS`. Those guards are behaviour-identical
-- to an unguarded statement on a first application; the wrap's was not.

-- 1. application_packages.config -> input_settings { values, locked }
--    `config` held the editor's stored values; they become `values` verbatim.
--    `locked` starts empty: no agent may silently acquire a lock it never had.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'application_packages'
      AND column_name = 'config'
  ) THEN
    ALTER TABLE "application_packages" RENAME COLUMN "config" TO "input_settings";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "application_packages" ALTER COLUMN "input_settings" SET DEFAULT '{"values":{},"locked":[]}'::jsonb;--> statement-breakpoint
--    UNCONDITIONAL, and deliberately so — see the header. Every row reaching
--    this statement holds a raw `config` object, because the RENAME above is the
--    only thing that ever produced this column. `input_settings` is NOT NULL (it
--    inherits `config`'s `DEFAULT '{}' NOT NULL`), so there is no NULL row to
--    skip either.
UPDATE "application_packages"
SET "input_settings" = jsonb_build_object('values', "input_settings", 'locked', '[]'::jsonb);--> statement-breakpoint

-- 2. package_schedules.config_override -> input
--    LIVE data, not history: these are the values a schedule freezes and
--    replays on every fire (the route accepted `config_override` and the
--    scheduler merged it at fire time). Dropping without this fold would make
--    every affected schedule fire without them — silently, since the renderer
--    resolves an absent key to the empty string.
--    The fold itself is naturally repeatable (`input` on the right already holds
--    the merged result), so it only needs the column to still be there.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'package_schedules'
      AND column_name = 'config_override'
  ) THEN
    UPDATE "package_schedules"
    SET "input" = COALESCE("config_override", '{}'::jsonb) || COALESCE("input", '{}'::jsonb)
    WHERE "config_override" IS NOT NULL;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "package_schedules" DROP COLUMN IF EXISTS "config_override";--> statement-breakpoint

-- 3. runs.config -> input, then drop both run columns.
--    History rather than live data, but for a config-only agent `runs.input`
--    was NULL, so dropping bare would erase every record of what those runs
--    actually executed with. `config` is the RESOLVED snapshot and already
--    contains whatever `config_override` contributed, so folding `config`
--    alone is complete and `config_override` needs no separate fold.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'config'
  ) THEN
    UPDATE "runs"
    SET "input" = COALESCE("config", '{}'::jsonb) || COALESCE("input", '{}'::jsonb)
    WHERE "config" IS NOT NULL;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "config";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "config_override";
