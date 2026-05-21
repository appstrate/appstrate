-- Remove the provider AFPS package type — drop the four provider-only
-- tables and the two provider-only columns on `runs`. The credential
-- proxy now resolves exclusively from `integration_connections`, so these
-- tables are dead. CASCADE clears the dependent FKs/indexes.
DROP TABLE IF EXISTS "user_provider_connections" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "app_profile_provider_bindings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "user_agent_provider_profiles" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "application_provider_credentials" CASCADE;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "provider_statuses";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "provider_profile_ids";
