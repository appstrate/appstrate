-- `runs.inference_route`: who reaches the model vendor for a platform run —
-- `proxy` (the platform LLM proxy serves the run's pinned `model_id` and
-- writes its ledger rows) or `sidecar` (the run's sidecar holds an OAuth
-- subscription token; the runner reports its own usage).
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2): a nullable column, no
-- backfill. NULL = no route recorded (every remote-origin run, every row
-- existing at migration time): the runner's ledger row is kept and the
-- proxy's run entry refuses the run. Every existing row is NULL, so the
-- CHECK validates vacuously.
--
-- ROLLBACK: a previous build never reads the column; drop the constraint,
-- the column, then the type.

CREATE TYPE "public"."inference_route" AS ENUM('proxy', 'sidecar');--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "inference_route" "inference_route";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_proxy_route_has_model" CHECK (inference_route <> 'proxy' OR model_id IS NOT NULL);