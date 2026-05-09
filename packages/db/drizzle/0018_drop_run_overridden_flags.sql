-- Drop the three derivable "overridden" boolean flags from `runs`.
--
-- Before: `runs.model_overridden` / `proxy_overridden` / `version_overridden`
-- were stamped at INSERT to drive "default vs override" badges on the run
-- detail page. The original justification (cf. 0013_per_run_overrides.sql)
-- was that the booleans were "cheaper than diffing snapshot vs persisted-
-- at-run-time on every render". In practice the badge is computed once
-- per render in the API mapper — an O(1) lookup against the resolved
-- `runs.config` snapshot — so the columns added DB width without
-- delivering a measurable read win.
--
-- After: the booleans are computed on read in `apps/api/src/services/state/
-- runs.ts::mapEnrichedRun` from `runs.model_label` / `proxy_label` /
-- `version_label` against `runs.config?.defaults?.<slot>`. The OpenAPI
-- shape (`Run.modelOverridden` / `proxyOverridden` / `versionOverridden`)
-- is unchanged — frontend consumers see the same wire contract.
--
-- Idempotent: `DROP COLUMN IF EXISTS` so re-applying is a no-op.
-- Rollout note: applied automatically at boot via `applyCoreMigrations()`.
-- No operator action required, no data migration (the booleans were
-- denormalized derivations, not source-of-truth data).

ALTER TABLE "runs"
  DROP COLUMN IF EXISTS "model_overridden",
  DROP COLUMN IF EXISTS "proxy_overridden",
  DROP COLUMN IF EXISTS "version_overridden";
