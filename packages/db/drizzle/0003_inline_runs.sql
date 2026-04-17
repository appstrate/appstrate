-- Inline runs — shadow packages + run denormalization.
-- See docs/specs/INLINE_RUNS.md

-- NOTE: `runs.package_id` is `NOT NULL ON DELETE CASCADE`. Never hard-delete
-- an ephemeral row: cascade would wipe its run history. Compaction sets
-- `draft_manifest = '{}'::jsonb` / `draft_content = ''` and preserves the row.

ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "ephemeral" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_packages_ephemeral_created" ON "packages" ("created_at") WHERE "ephemeral" = true;
--> statement-breakpoint

-- Denormalize agent @scope/name on runs so the global /runs view keeps
-- working after the underlying package is renamed, deleted, or compacted.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "agent_scope" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "agent_name" text;
