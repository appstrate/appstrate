-- `runs.model_id`: the model a run launched with — a system model id or an
-- `org_models.id`. The platform LLM proxy serves a platform run's own inference
-- from it rather than from a model the request names.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2): a nullable column, no
-- backfill. A run launched before this migration keeps NULL and is never
-- served by that entry — it holds its credential the way it was launched.
--
-- ROLLBACK: a previous build never reads the column; dropping it is safe.

ALTER TABLE "runs" ADD COLUMN "model_id" text;
