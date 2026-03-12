ALTER TABLE "org_models" RENAME COLUMN "provider" TO "api";--> statement-breakpoint
ALTER TABLE "org_models" ADD COLUMN "base_url" text NOT NULL DEFAULT '';