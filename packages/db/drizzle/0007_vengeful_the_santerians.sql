ALTER TABLE "org_models" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "org_models" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "org_models" ADD COLUMN "max_tokens" integer;--> statement-breakpoint
ALTER TABLE "org_models" ADD COLUMN "reasoning" boolean;