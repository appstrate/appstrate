-- Persist a snapshot of the effective agent config on every run.
-- Applies to both classic and inline runs so the Info tab can render
-- the config that was active when the run started — decoupled from the
-- package's current config (which may have changed since).

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "config" jsonb;
