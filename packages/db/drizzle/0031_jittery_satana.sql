ALTER TABLE "llm_usage" ADD COLUMN "pricing_status" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model_cost" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_pricing_status" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_pricing_status_valid" CHECK (pricing_status IN ('priced', 'partial', 'unpriced'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cost_pricing_status_valid" CHECK (cost_pricing_status IN ('priced', 'partial', 'unpriced'));