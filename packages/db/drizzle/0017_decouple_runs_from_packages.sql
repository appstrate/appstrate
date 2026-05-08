-- Decouple `runs` from `packages`: runs survive agent deletion.
--
-- Before: `runs.package_id` was NOT NULL with `ON DELETE CASCADE`. Deleting an
-- agent wiped its entire run history (and the cascade also surfaced the
-- llm_usage CHECK violation that 0016 fixes). The schema already shipped
-- denormalized snapshots `agent_scope`, `agent_name`, `version_label`,
-- `model_label`, `runner_name`, `cost`, … on the runs row at INSERT time —
-- explicitly intended to "survive package rename, delete, or inline-run
-- compaction" (cf. comment on `runs.agent_scope` in `runs.ts`). The CASCADE
-- contradicted that intent: the snapshots existed but were never read,
-- because the rows they were meant to outlive were deleted alongside the
-- package.
--
-- After: `runs.package_id` is nullable with `ON DELETE SET NULL`. Deleting an
-- agent SETs the run's package_id to NULL; the run row, its run_logs (FK to
-- runs.id, cascade), and its llm_usage rows (FK to runs.id, cascade as of
-- 0016) all survive. The global runs view falls back to `agent_scope` /
-- `agent_name` for display when the source package is gone.
--
-- Cascades that are intentionally NOT changed:
--   - `package_schedules.package_id` — a schedule without an agent has no
--     value; cascade-delete is correct.
--   - `package_persistence.package_id` — the agent's memory archive and
--     pinned slots are solidary of the agent (ADR-011/012/013).
--   - `runs.org_id` / `runs.application_id` — org/app deletion still wipes
--     runs as a tenant-isolation invariant.
--
-- Idempotent: drops and re-creates the FK. Backfill uses COALESCE so it
-- only touches rows where the snapshot is still missing.
--
-- Rollout note: applied automatically at boot via `applyCoreMigrations()`.
-- No operator action required.

-- Step 1: backfill denormalized snapshots for legacy runs predating the
-- `agent_scope` / `agent_name` columns. Best-effort — runs whose source
-- package is already gone will keep null snapshots and render as "deleted
-- agent" in the UI. The display name comes from `draft_manifest` (the
-- in-memory editable manifest); for published-only agents that field may
-- be null, in which case we fall back to the slug from the id.
UPDATE "runs" r
SET
  "agent_scope" = COALESCE(
    r."agent_scope",
    NULLIF(split_part(p."id", '/', 1), '')
  ),
  "agent_name" = COALESCE(
    r."agent_name",
    NULLIF(p."draft_manifest"->>'displayName', ''),
    NULLIF(p."draft_manifest"->>'name', ''),
    NULLIF(split_part(p."id", '/', 2), '')
  )
FROM "packages" p
WHERE p."id" = r."package_id"
  AND (r."agent_scope" IS NULL OR r."agent_name" IS NULL);

-- Step 2: drop NOT NULL on runs.package_id.
ALTER TABLE "runs" ALTER COLUMN "package_id" DROP NOT NULL;

-- Step 3: switch FK from CASCADE to SET NULL.
ALTER TABLE "runs"
  DROP CONSTRAINT IF EXISTS "runs_package_id_packages_id_fk";

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_package_id_packages_id_fk"
    FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE SET NULL;
