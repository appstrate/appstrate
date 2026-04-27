-- Per-run + per-schedule override layer.
--
-- The `config` column on `runs` stores the resolved (deep-merged) snapshot
-- used by the runtime. `config_override` records the raw delta the caller
-- sent on `POST /run` (CLI `--config`, API `config?: object`, schedule
-- fire-time merge), so a replay can reproduce the exact same payload
-- without diffing against possibly-mutated `application_packages.config`.
--
-- The boolean override flags mark which slots came from the request vs
-- the persisted defaults — useful for audit, debugging, and any future
-- consumer that needs to distinguish "explicit choice" from "inherited".
--
-- `package_schedules` gets the same four override columns. A schedule is
-- semantically a recurring run, so the same override layer applies at
-- fire time (Argo CronWorkflow inherit-with-override semantics).

ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "config_override" jsonb,
  ADD COLUMN IF NOT EXISTS "model_overridden" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "proxy_overridden" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "version_overridden" boolean NOT NULL DEFAULT false;

ALTER TABLE "package_schedules"
  ADD COLUMN IF NOT EXISTS "config_override" jsonb,
  ADD COLUMN IF NOT EXISTS "model_id_override" text,
  ADD COLUMN IF NOT EXISTS "proxy_id_override" text,
  ADD COLUMN IF NOT EXISTS "version_override" text;
