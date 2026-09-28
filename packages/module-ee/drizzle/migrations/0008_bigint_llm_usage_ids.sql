-- Widen the columns holding `llm_usage.id` values to bigint, following the
-- platform's migration 0069 which widens `llm_usage.id` itself (bigserial). An
-- int4 claim or watermark would overflow as soon as the ledger id passes
-- 2^31 - 1. No DML; every int4 value is a valid int8.
ALTER TABLE "ee_billed_llm_usage" ALTER COLUMN "llm_usage_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ee_billing_cursor" ALTER COLUMN "last_llm_usage_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ee_billing_cursor" ALTER COLUMN "floor_id" SET DATA TYPE bigint;
