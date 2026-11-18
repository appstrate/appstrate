-- Index for the terminal-run cursor read (`PlatformServices.runs.listTerminal`), which a
-- metering module sweeps by `(completed_at, id)`. Partial: only finished runs carry a
-- `completed_at`.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` section 2): an index, no data touched.
--
-- ROLLBACK: drop the index; nothing reads it but that service.
CREATE INDEX "idx_runs_completed_at" ON "runs" USING btree ("completed_at","id") WHERE "runs"."completed_at" IS NOT NULL;
