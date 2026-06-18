DROP INDEX "idx_org_models_one_default";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "default_model_id" text;--> statement-breakpoint
ALTER TABLE "org_models" DROP COLUMN "is_default";