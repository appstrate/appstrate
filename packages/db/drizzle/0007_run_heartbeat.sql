-- Runner liveness watchdog.
--
-- Single unified stall-detection path for every runner type (platform
-- container, remote CLI, GitHub Action, …). The runs row records the
-- timestamp of the last proof-of-life received from the runner:
--   - event POST   → bumped by ingestion
--   - /sink/extend → bumped by the route handler
-- A background watchdog sweeps rows whose last_heartbeat_at slipped
-- past the stall threshold and routes them through the same
-- `finalizeRun()` convergence point used by natural termination and
-- container-exit synthesis. The CAS on `sink_closed_at IS NULL`
-- inside finalizeRun guarantees exactly-once closure under races
-- (container crash detected by waitForExit vs watchdog vs late POST).
--
-- Default NOW() on backfill so existing running rows at deploy time
-- aren't immediately swept — they get a full stall window to report in.

ALTER TABLE "runs"
  ADD COLUMN "last_heartbeat_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Partial index: watchdog only scans open-sink rows. The same filter
-- condition is used by the sweep query, so the index covers it fully.
CREATE INDEX IF NOT EXISTS "idx_runs_stall_sweep"
  ON "runs" ("last_heartbeat_at")
  WHERE sink_closed_at IS NULL AND sink_expires_at IS NOT NULL;
