-- Per-run + per-schedule override layer.
--
-- The `config` column on `runs` already stores the resolved (deep-merged)
-- snapshot. `config_override` records the raw delta the caller sent on
-- `POST /run`, so the dashboard can badge "default vs override" and a
-- "Re-run with these settings" button can replay the exact same payload
-- without diffing against possibly-mutated `application_packages.config`.
--
-- The boolean override flags drive UI badges without forcing the client
-- to compare snapshot vs persisted-at-run-time on every render.
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
