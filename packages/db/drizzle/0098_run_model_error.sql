-- A run that failed on a model call, classified once at finalize (`describeModelFailure`):
-- its class, the provider's HTTP status and its own sentence. Nullable, no backfill: a run
-- finalized before this migration recorded none of it.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "model_error_category" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "model_error_status" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "model_error_message" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_error_category_valid" CHECK (model_error_category IN ('credential_unavailable', 'rate_limited', 'upstream_unavailable', 'invalid_request', 'unknown'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_error_detail_has_category" CHECK (model_error_category IS NOT NULL OR (model_error_status IS NULL AND model_error_message IS NULL));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_error_status_http" CHECK (model_error_status BETWEEN 100 AND 599);
