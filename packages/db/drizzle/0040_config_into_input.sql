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
-- CONVERGENT, like its siblings 0039 and 0041-0044: running the whole file a
-- second time is a no-op, not an error. Every DDL statement is guarded on the
-- catalog and every fold is gated on its own effect, because this file has been
-- edited since it was first applied and drizzle keys applied migrations by
-- content hash — an existing dev database WILL run it again. Two of the
-- statements were destructive under a re-run and are now not: the RENAME (which
-- errored once `config` was gone) and the `application_packages` wrap (which
-- would have nested the row a second time into
-- `{"values":{"values":…,"locked":[]},"locked":[]}`).

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
-- The wrap is gated on the row not already being wrapped. `input_settings` is
-- NOT NULL (it inherits `config`'s `DEFAULT '{}' NOT NULL`), so the predicate is
-- never NULL-tristate. Both keys are tested, and `locked` is tested for being an
-- array: `config` held arbitrary author-defined parameter names, and a single
-- field called `values` would otherwise make an unwrapped row read as wrapped.
UPDATE "application_packages"
SET "input_settings" = jsonb_build_object('values', "input_settings", 'locked', '[]'::jsonb)
WHERE NOT (
  "input_settings" ? 'values'
  AND "input_settings" ? 'locked'
  AND jsonb_typeof("input_settings" -> 'locked') = 'array'
);--> statement-breakpoint

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
