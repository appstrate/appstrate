-- A later migration must not use 'user' (DML, DEFAULT, CHECK): drizzle applies every
-- pending migration in one transaction, and Postgres refuses a value added to an
-- existing enum in the transaction that added it. No backfill: NULL = not recorded.
ALTER TYPE "public"."credential_source" ADD VALUE 'user';--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "payer_user_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "payer_user_id" text;
