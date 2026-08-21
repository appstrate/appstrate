-- Collapse the manifest `config` schema into `input`.
--
-- The platform used to carry two parameter namespaces per agent. It now carries
-- one. This migration moves every column that expressed the split onto the
-- surviving `input` side, then drops the split.
--
-- FORWARD-ONLY and data-preserving: every value a dropped column held is folded
-- into its `input` counterpart BEFORE the DROP, so no row loses a parameter.
--
-- Collision rule, used identically in all three folds and in the manifest merge
-- performed by scripts/migrate-config-to-input.ts: `input` wins. `a || b` is a
-- shallow jsonb merge where the RIGHT operand takes precedence, so `input` is
-- always written on the right. A key present in both keeps the `input` value —
-- the same property that survives the manifest merge.
--
-- NOTE ON ORDERING: this DDL runs automatically at boot, while the manifest and
-- prompt rewrite (scripts/migrate-config-to-input.ts --apply) is a manual step
-- that can only run afterwards, since it reads the renamed column. Between the
-- two, published agents still carry `{{config.x}}` in prompt.md, which the
-- renderer resolves to the empty string. Run the script immediately after
-- deploying. See the script's docstring.

-- 1. application_packages.config -> input_settings { values, locked }
--    `config` held the editor's stored values; they become `values` verbatim.
--    `locked` starts empty: no agent may silently acquire a lock it never had.
ALTER TABLE "application_packages" RENAME COLUMN "config" TO "input_settings";--> statement-breakpoint
ALTER TABLE "application_packages" ALTER COLUMN "input_settings" SET DEFAULT '{"values":{},"locked":[]}'::jsonb;--> statement-breakpoint
UPDATE "application_packages" SET "input_settings" = jsonb_build_object('values', "input_settings", 'locked', '[]'::jsonb);--> statement-breakpoint

-- 2. package_schedules.config_override -> input
--    LIVE data, not history: these are the values a schedule freezes and
--    replays on every fire (the route accepted `config_override` and the
--    scheduler merged it at fire time). Dropping without this fold would make
--    every affected schedule fire without them — silently, since the renderer
--    resolves an absent key to the empty string.
UPDATE "package_schedules"
SET "input" = COALESCE("config_override", '{}'::jsonb) || COALESCE("input", '{}'::jsonb)
WHERE "config_override" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "package_schedules" DROP COLUMN "config_override";--> statement-breakpoint

-- 3. runs.config -> input, then drop both run columns.
--    History rather than live data, but for a config-only agent `runs.input`
--    was NULL, so dropping bare would erase every record of what those runs
--    actually executed with. `config` is the RESOLVED snapshot and already
--    contains whatever `config_override` contributed, so folding `config`
--    alone is complete and `config_override` needs no separate fold.
UPDATE "runs"
SET "input" = COALESCE("config", '{}'::jsonb) || COALESCE("input", '{}'::jsonb)
WHERE "config" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "config";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "config_override";
